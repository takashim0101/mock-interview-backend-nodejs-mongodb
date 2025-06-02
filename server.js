// C:\Level 5\Mission 3_1\mock-interview-backend-nodejs-mongodb\server.js

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// CORS configuration
const allowedOrigins = [
    'http://localhost:5173',
    'https://lively-coast-026e29100.6.azurestaticapps.net'
];

app.use(cors({
    origin: function (origin, callback) {
        console.log('CORS Request Origin:', origin); // Log the incoming origin
        if (!origin) {
            console.log('CORS: Origin is null (e.g., same-origin or non-browser request)');
            return callback(null, true);
        }
        if (allowedOrigins.indexOf(origin) === -1) {
            const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
            console.error('CORS Error: Blocked origin', origin); // Log blocked origins
            return callback(new Error(msg), false);
        }
        console.log('CORS: Allowed origin', origin); // Log allowed origins
        return callback(null, true);
    },
    credentials: true
}));

// MongoDB Connection
const DB_CONNECTION_STRING = process.env.DB_CONNECTION_STRING;
if (!DB_CONNECTION_STRING) {
    console.error('CRITICAL ERROR: DB_CONNECTION_STRING is not set. Application cannot start.');
    process.exit(1); // Exit if critical env var is missing for clear Azure logs
} else {
    mongoose.connect(DB_CONNECTION_STRING)
        .then(() => console.log('Successfully connected to MongoDB!'))
        .catch(err => {
            console.error('MongoDB connection error:', err);
            process.exit(1); // Exit if database connection fails
        });
}

// Google Generative AI setup
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
let geminiAi;
if (!GOOGLE_API_KEY) {
    console.error('CRITICAL ERROR: GOOGLE_API_KEY is not set. Application cannot start without AI features.');
    process.exit(1); // Exit if critical env var is missing for clear Azure logs
} else {
    geminiAi = new GoogleGenerativeAI(GOOGLE_API_KEY);
}

// MongoDB Chat Session Model
const ChatSessionSchema = new mongoose.Schema({
    sessionId: { type: String, required: true, unique: true },
    jobTitle: { type: String, required: true },
    history: { type: Array, default: [] },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

const ChatSession = mongoose.model('ChatSession', ChatSessionSchema);

// Helper function to format history for Gemini
function formatHistoryForGemini(history) {
    return history.map(entry => ({
        role: entry.role,
        parts: [{ text: entry.text }]
    }));
}

// Interview API Endpoint
app.post('/api/interview', async (req, res) => {
    const { sessionId, jobTitle, userResponse } = req.body;

    if (!sessionId || !jobTitle || userResponse === undefined || userResponse === null) {
        return res.status(400).json({ error: 'Missing sessionId, jobTitle, or userResponse in request body.' });
    }

    try {
        let chatSession = await ChatSession.findOne({ sessionId });

        if (!chatSession) {
            chatSession = new ChatSession({
                sessionId,
                jobTitle,
                history: []
            });
            console.log(`New chat session created for sessionId: ${sessionId}`);
        }

        if (!geminiAi) {
            throw new Error('Gemini AI is not initialized. GOOGLE_API_KEY might be missing or invalid.');
        }

        const model = geminiAi.getGenerativeModel({
            model: "gemini-1.5-flash",
            systemInstruction: {
                role: "system",
                // --- IMPORTANT CHANGE: Updated system instruction for the AI ---
                // This new instruction tells Gemini exactly how to start and when to end the interview.
                parts: [{
                    text: `You are an AI interviewer for a job titled "${jobTitle}".
                    Your goal is to conduct a mock interview by asking relevant questions.
                    Start by asking the user to "Tell me about yourself.".
                    After that, ask up to 6 follow-up questions one at a time, based on the user's responses and the job title.
                    Ensure your questions are typical for a job interview.
                    Once the 6 questions are asked, provide constructive feedback on the user's answers and interview performance.
                    Keep your responses concise and professional.`
                }]
            }
        });

        let messageToGemini = userResponse;
        // This condition is still needed to trigger the very first response from the AI
        // when the user's initial input is empty (i.e., when they just start the session).
        if (chatSession.history.length === 0 && (userResponse === '' || userResponse === null)) {
            messageToGemini = "start a mock interview session"; 
        }

        const chat = model.startChat({
            history: formatHistoryForGemini(chatSession.history)
        });

        // Push the user's actual (or placeholder) message to history
        chatSession.history.push({ role: 'user', text: messageToGemini });

        const result = await chat.sendMessageStream(messageToGemini);
        let geminiResponseText = '';
        for await (const chunk of result.stream) {
            geminiResponseText += chunk.text();
        }

        chatSession.history.push({ role: 'model', text: geminiResponseText });

        await chatSession.save();

        res.json({
            sessionId: chatSession.sessionId,
            response: geminiResponseText,
            history: chatSession.history
        });

    } catch (error) {
        console.error('Error in /api/interview:', error);
        if (error.message.includes('Database') || (error.message.includes('MongoDB') && !error.message.includes('Cast to ObjectId'))) {
            res.status(500).json({ error: 'Failed to access chat session in database.' });
        } else if (error.message.includes('Gemini AI') || error.message.includes('GoogleGenerativeAI') || error.message.includes('AI response')) {
            res.status(500).json({ error: 'Failed to process interview request or get AI response. Please check backend logs for details.' });
        } else {
            res.status(500).json({ error: 'Failed to process interview request or get AI response. Please check backend logs for details.' });
        }
    }
});

let server;

if (require.main === module) {
    server = app.listen(port, () => {
        console.log(`Backend server running on http://localhost:${port}`);
        console.log(`Actual port being listened on: ${port}`); // Log the actual port
        console.log(`DB_CONNECTION_STRING status: ${DB_CONNECTION_STRING ? 'Set and Used' : 'NOT SET'}`);
        console.log(`GOOGLE_API_KEY status: ${GOOGLE_API_KEY ? 'Set and Used' : 'NOT SET'}`);
        console.log(`CORS allowed origins: ${allowedOrigins.join(', ')}`);
    });
}

module.exports = app;
if (server) {
    module.exports.serverInstance = server;
}