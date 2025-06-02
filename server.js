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
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) === -1) {
            const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
            return callback(new Error(msg), false);
        }
        return callback(null, true);
    },
    credentials: true
}));

// MongoDB Connection
const DB_CONNECTION_STRING = process.env.DB_CONNECTION_STRING;
if (DB_CONNECTION_STRING) {
    mongoose.connect(DB_CONNECTION_STRING)
        .then(() => console.log('Successfully connected to MongoDB!'))
        .catch(err => console.error('MongoDB connection error:', err));
} else {
    console.warn('DB_CONNECTION_STRING is not set in .env. Database operations will fail.');
}

// Google Generative AI setup
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
let geminiAi;
if (GOOGLE_API_KEY) {
    geminiAi = new GoogleGenerativeAI(GOOGLE_API_KEY);
} else {
    console.warn('GOOGLE_API_KEY is not set in .env. AI features will not be available.');
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

        const model = geminiAi.getGenerativeModel({
            model: "gemini-1.5-flash",
            systemInstruction: {
                role: "system",
                parts: [{
                    text: `You are an expert technical interviewer for a job titled "${jobTitle}".
                    Your goal is to ask relevant, challenging questions to assess the candidate's skills for this role.
                    Focus on practical, scenario-based questions and dive deep into their responses.
                    Maintain a professional and encouraging tone.
                    If the user response is empty for the first question, start with a general introductory question.
                    If the user response is empty for subsequent questions, prompt them to provide more details or ask if they'd like to move to the next question.
                    Keep responses concise and direct.`
                }]
            }
        });

        let messageToGemini = userResponse;
        if (chatSession.history.length === 0 && userResponse === '') {
            messageToGemini = "start a mock interview";
        }

        const chat = model.startChat({
            history: formatHistoryForGemini(chatSession.history)
        });

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
        if (error.message.includes('Database')) {
            res.status(500).json({ error: 'Failed to access chat session in database.' });
        } else {
            res.status(500).json({ error: 'Failed to process interview request or get AI response. Please check backend logs for details.' });
        }
    }
});

let server;

if (require.main === module) {
    server = app.listen(port, () => {
        console.log(`Backend server running on http://localhost:${port}`);
        console.log(`MongoDB connection string in use: ${DB_CONNECTION_STRING ? 'Set' : 'NOT SET (check .env)'}`);
        console.log(`Google API Key in use: ${GOOGLE_API_KEY ? 'Set' : 'NOT SET (check .env)'}`);
        console.log(`CORS allowed origins in server.js: ${allowedOrigins.join(', ')}`);
    });
}

module.exports = app;
if (server) {
    module.exports.serverInstance = server;
}