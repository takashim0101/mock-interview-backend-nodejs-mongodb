// server.js
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const mongoose = require('mongoose'); // Add this line

dotenv.config();


// === Database Connection and Model Definition (Significant Changes Here) ===
const DB_CONNECTION_STRING = process.env.DB_CONNECTION_STRING;
if (!DB_CONNECTION_STRING) {
    console.error('DB_CONNECTION_STRING is not set in .env file');
    process.exit(1);
}

mongoose.connect(DB_CONNECTION_STRING)
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => {
        console.error('MongoDB connection error:', err);
        // Exit the application if database connection fails
        process.exit(1);
    });

// Define the schema and model for your chat sessions
const chatSchema = new mongoose.Schema({
    sessionId: { type: String, required: true, unique: true },
    history: [{
        role: String,
        text: String,
        timestamp: { type: Date, default: Date.now }
    }],
    jobTitle: String,
    createdAt: { type: Date, default: Date.now }
});
const ChatSession = mongoose.model('ChatSession', chatSchema);
// ====================================================================

const app = express(); // add a comment to trigger redeploy  
const port = process.env.PORT || 3000;

//CORS setting
app.use(cors({
    origin: 'http://localhost:5173',
}));


// Middleware
// app.use(cors());
// Middleware
app.use(cors());
app.use(express.json());

// Gemini API Configuration
const API_KEY = process.env.GOOGLE_API_KEY;
if (!API_KEY) {
    console.error('GOOGLE_API_KEY is not set in .env file');
    process.exit(1);
}
const genAI = new GoogleGenerativeAI(API_KEY);

// A map for saving conversation history (this will be replaced with a database this time)
// Map to store conversation history (simple example, use a database in production)
// const chatHistories = new Map(); This line will become unnecessary, but I will comment it out just in case.

//Routing setting
app.post('/api/interview', async (req, res) => {
    const { sessionId, jobTitle, userResponse } = req.body;

    if (!sessionId || !jobTitle || userResponse === undefined) {
        return res.status(400).json({ error: 'Missing sessionId, jobTitle, or userResponse' });
    }

    let chatSession;
    try {
        // === Change: Find existing session from database or create a new one ===
        chatSession = await ChatSession.findOne({ sessionId });
        if (!chatSession) {
            chatSession = new ChatSession({ sessionId, jobTitle, history: [] });
        } else {
            // Update jobTitle even if session exists (for flexibility with frontend changes)
            chatSession.jobTitle = jobTitle;
        }
    } catch (dbError) {
        console.error('Database find/create error:', dbError);
        return res.status(500).json({ error: 'Failed to access chat session in database.' });
    }

    // Use history retrieved from the database
    let history = chatSession.history;

    try {
        const model = genAI.getGenerativeModel({
            model: "gemini-1.5-flash",
            systemInstruction: {
                parts: [
                    { text: `You are an AI interviewer for a job titled "${jobTitle}".` },
                    { text: `Your goal is to conduct a mock interview by asking relevant questions.` },
                    { text: `Start by asking the user to "Tell me about yourself.".` },
                    { text: `After that, ask up to 6 follow-up questions one at a time, based on the user's responses and the job title.` },
                    { text: `Ensure your questions are typical for a job interview.` },
                    { text: `Once the 6 questions are asked, provide constructive feedback on the user's answers and interview performance.` },
                    { text: `Keep your responses concise and professional.` }
                ]
            },
            generationConfig: {
                responseMimeType: "text/plain",
            },
        });

        const chat = model.startChat({
            history: history.map(item => ({
                role: item.role,
                parts: [{ text: item.text }]
            }))
        });

        let apiResponse;
        if (history.length === 0) {
            apiResponse = await chat.sendMessageStream(userResponse || "start interview");
        } else {
            apiResponse = await chat.sendMessageStream(userResponse);
        }

        let fullResponse = '';
        for await (const chunk of apiResponse.stream) {
            if (typeof chunk.text === 'function') {
                fullResponse += chunk.text();
            } else if (typeof chunk.text === 'string') {
                fullResponse += chunk.text;
            } else {
                console.warn('Unexpected type for chunk.text:', typeof chunk.text, chunk.text);
                if (chunk.candidates && chunk.candidates.length > 0 &&
                    chunk.candidates[0].content && chunk.candidates[0].content.parts &&
                    chunk.candidates[0].content.parts.length > 0) {
                    fullResponse += chunk.candidates[0].content.parts[0].text;
                }
            }
        }

        // Add new messages to the chatSession object's history
        if (userResponse !== undefined && userResponse !== "start interview") {
            chatSession.history.push({ role: 'user', text: userResponse });
        }
        chatSession.history.push({ role: 'model', text: fullResponse });

        // === Change: Save the updated session to the database ===
        await chatSession.save(); // This persists the changes to MongoDB

        res.json({ response: fullResponse, history: chatSession.history });

    } catch (error) {
        console.error('Error calling Gemini API or saving session:', error);
        res.status(500).json({ error: 'Failed to get response from AI interviewer or save session.' });
    }
});

app.listen(port, () => {
    console.log(`Backend server running on http://localhost:${port}`);
});