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
        console.log('CORS Request Origin:', origin); // 追加: CORS リクエストのオリジンをログに出力
        if (!origin) {
            console.log('CORS: Origin is null (e.g., same-origin or non-browser request)'); // 追加: オリジンがnullの場合のログ
            return callback(null, true);
        }
        if (allowedOrigins.indexOf(origin) === -1) {
            const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
            console.error('CORS Error: Blocked origin', origin); // 追加: ブロックされたオリジンをエラーログに出力
            return callback(new Error(msg), false);
        }
        console.log('CORS: Allowed origin', origin); // 追加: 許可されたオリジンをログに出力
        return callback(null, true);
    },
    credentials: true
}));

// MongoDB Connection
const DB_CONNECTION_STRING = process.env.DB_CONNECTION_STRING;
if (!DB_CONNECTION_STRING) {
    console.error('CRITICAL ERROR: DB_CONNECTION_STRING is not set. Application cannot start.');
    process.exit(1); // 環境変数がない場合、アプリケーションを終了
} else {
    mongoose.connect(DB_CONNECTION_STRING)
        .then(() => console.log('Successfully connected to MongoDB!'))
        .catch(err => {
            console.error('MongoDB connection error:', err);
            process.exit(1); // データベース接続エラー時もアプリケーションを終了
        });
}

// Google Generative AI setup
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
let geminiAi;
if (!GOOGLE_API_KEY) {
    console.error('CRITICAL ERROR: GOOGLE_API_KEY is not set. Application cannot start without AI features.');
    process.exit(1); // 環境変数がない場合、アプリケーションを終了
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

        // geminiAi が初期化されていることを確認する（念のため）
        if (!geminiAi) {
            throw new Error('Gemini AI is not initialized. GOOGLE_API_KEY might be missing or invalid.');
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
        // エラーメッセージに 'Database' または 'Gemini AI' が含まれるか確認し、より具体的なエラーメッセージを返す
        if (error.message.includes('Database') || (error.message.includes('MongoDB') && !error.message.includes('Cast to ObjectId'))) {
            res.status(500).json({ error: 'Failed to access chat session in database.' });
        } else if (error.message.includes('Gemini AI') || error.message.includes('GoogleGenerativeAI')) {
            res.status(500).json({ error: 'Failed to get AI response. Please check backend logs and GOOGLE_API_KEY.' });
        }
        else {
            res.status(500).json({ error: 'Failed to process interview request. Please check backend logs for details.' });
        }
    }
});

let server;

if (require.main === module) {
    server = app.listen(port, () => {
        console.log(`Backend server running on http://localhost:${port}`);
        console.log(`Actual port being listened on: ${port}`); // 追加: 実際にリッスンしているポートをログに出力
        console.log(`DB_CONNECTION_STRING status: ${DB_CONNECTION_STRING ? 'Set and Used' : 'NOT SET'}`);
        console.log(`GOOGLE_API_KEY status: ${GOOGLE_API_KEY ? 'Set and Used' : 'NOT SET'}`);
        console.log(`CORS allowed origins: ${allowedOrigins.join(', ')}`);
    });
}

module.exports = app;
if (server) {
    module.exports.serverInstance = server;
}