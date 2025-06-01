// Import necessary modules
const express = require('express');
const cors = require('cors'); // Middleware for enabling Cross-Origin Resource Sharing - (Re-added)
const dotenv = require('dotenv'); // To load environment variables from .env file
const { GoogleGenerativeAI } = require('@google/generative-ai'); // Google Gemini API SDK
const mongoose = require('mongoose'); // Mongoose for MongoDB object modeling

// Load environment variables from .env file at the very beginning
dotenv.config();

// --- Database Connection and Model Definition ---
const DB_CONNECTION_STRING = process.env.DB_CONNECTION_STRING;

// Check if MongoDB connection string is provided
if (!DB_CONNECTION_STRING) {
    console.error('Error: DB_CONNECTION_STRING is not set in the .env file. Please provide it to connect to MongoDB.');
    process.exit(1); // Exit the application if essential environment variable is missing
}

// Establish MongoDB connection
mongoose.connect(DB_CONNECTION_STRING)
    .then(() => console.log('Successfully connected to MongoDB!'))
    .catch(err => {
        console.error('MongoDB connection error:', err, err.message);
        // Exit the application if database connection fails, as it's critical
        process.exit(1);
    });

// Define the Mongoose schema for chat sessions
const chatSchema = new mongoose.Schema({
    sessionId: {
        type: String,
        required: true,
        unique: true
    },
    history: [{
        role: {
            type: String,
            required: true
        },
        text: {
            type: String,
            required: true
        },
        timestamp: {
            type: Date,
            default: Date.now
        }
    }],
    jobTitle: {
        type: String,
        required: true
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

// Pre-save hook to update 'updatedAt' field
chatSchema.pre('save', function(next) {
    this.updatedAt = Date.now();
    next();
});

// Create the Mongoose model from the schema
const ChatSession = mongoose.model('ChatSession', chatSchema);
// ====================================================================

// Initialize the Express application
const app = express();
const port = process.env.PORT || 8080; // Use port from .env or default to 8080

// --- CORS Configuration ---
// Define allowed origins for Cross-Origin Resource Sharing.
// This is crucial for security and allowing your frontend to communicate.
const allowedOrigins = [
    'http://localhost:5173', // Default Vite dev server port for your React frontend
    'https://lively-coast-026e29100.6.azurestaticapps.net' // Your deployed frontend's URL on Azure Static Web Apps
    // You might also add your backend's URL here if needed,
    // 'https://mockinterviewapp-backend-takashi01-d3c7e4gpcba9gxb0.centralindia-01.azurewebsites.net'
];

const corsOptions = {
    origin: function (origin, callback) {
        // Allow requests with no origin (e.g., same-origin requests, mobile apps, Postman/curl)
        // This is key for Postman when `*` is not used in Azure Portal CORS settings.
        if (!origin || allowedOrigins.includes(origin)) { // Changed from indexOf to includes for clarity
            callback(null, true);
        } else {
            callback(new Error(`Not allowed by CORS: ${origin}`));
        }
    },
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE', // Allowed HTTP methods
    credentials: true, // Allow sending cookies and HTTP authentication headers
    optionsSuccessStatus: 204 // For preflight requests (OPTIONS method)
};

// Apply the CORS middleware with specific options
app.use(cors(corsOptions));

// --- Other Middlewares ---
app.use(express.json()); // Middleware to parse JSON request bodies

// --- Google Gemini API Configuration ---
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

// Check if Google API Key is provided
if (!GOOGLE_API_KEY) {
    console.error('Error: GOOGLE_API_KEY is not set in the .env file. Please provide it to use the Gemini API.');
    process.exit(1);
}
const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);

// --- API Routes ---
app.post('/api/interview', async (req, res) => {
    const { sessionId, jobTitle, userResponse } = req.body;

    if (!sessionId || !jobTitle || userResponse === undefined) {
        return res.status(400).json({ error: 'Missing sessionId, jobTitle, or userResponse in request body.' });
    }

    let chatSession;
    try {
        chatSession = await ChatSession.findOne({ sessionId });

        if (!chatSession) {
            chatSession = new ChatSession({ sessionId, jobTitle, history: [] });
            console.log(`New session created for ID: ${sessionId}`);
        } else {
            chatSession.jobTitle = jobTitle;
            console.log(`Existing session found for ID: ${sessionId}`);
        }
    } catch (dbError) {
        console.error('Database find/create operation failed:', dbError);
        return res.status(500).json({ error: 'Failed to access chat session in database.' });
    }

    let history = chatSession.history;

    try {
        const model = genAI.getGenerativeModel({
            model: "gemini-1.5-flash",
            systemInstruction: {
                parts: [
                    { text: `You are an AI interviewer for a job titled "${jobTitle}".` },
                    { text: `Your goal is to conduct a mock interview by asking relevant questions.` },
                    { text: `Start by asking the user to "Tell me about yourself.". If the user's initial response is empty or just "start interview", generate this opening question.` },
                    { text: `After that, ask up to 6 follow-up questions one at a time, based on the user's responses and the job title.` },
                    { text: `Ensure your questions are typical for a job interview.` },
                    { text: `Once the 6 questions are asked, conclude the interview and then provide constructive feedback on the user's answers and interview performance. Mention the job title in your feedback conclusion.` },
                    { text: `Keep your responses concise and professional.` }
                ]
            },
            generationConfig: {
                responseMimeType: "text/plain",
            },
        });

        let historyForGemini = history.map(item => ({
            role: item.role,
            parts: [{ text: item.text }]
        }));

        let messageToSendToGemini = userResponse;

        if (history.length === 0) {
            messageToSendToGemini = userResponse || "start a mock interview";
        } else {
            chatSession.history.push({ role: 'user', text: userResponse });
            historyForGemini.push({ role: 'user', parts: [{ text: userResponse }] });
        }

        const chat = model.startChat({
            history: historyForGemini
        });

        const apiResponse = await chat.sendMessageStream(messageToSendToGemini);

        let fullResponse = '';
        for await (const chunk of apiResponse.stream) {
            if (typeof chunk.text === 'function') {
                fullResponse += chunk.text();
            } else if (typeof chunk.text === 'string') {
                fullResponse += chunk.text;
            } else if (chunk.candidates && chunk.candidates.length > 0 &&
                       chunk.candidates[0].content && chunk.candidates[0].content.parts &&
                       chunk.candidates[0].content.parts.length > 0 && chunk.candidates[0].content.parts[0].text) {
                fullResponse += chunk.candidates[0].content.parts[0].text;
            } else {
                console.warn('Unexpected chunk format received from Gemini API:', chunk);
            }
        }

        if (history.length === 0) {
            chatSession.history.push({ role: 'user', text: messageToSendToGemini });
        }
        chatSession.history.push({ role: 'model', text: fullResponse });

        await chatSession.save();

        res.json({ response: fullResponse, history: chatSession.history });

    } catch (error) {
        console.error('Error during Gemini API call or session saving:', error);
        res.status(500).json({ error: 'Failed to process interview request or get AI response. Please check backend logs for details.' });
    }
});

// --- Server Start ---
app.listen(port, () => {
    console.log(`Backend server running on http://localhost:${port}`);
    console.log(`MongoDB connection string in use: ${DB_CONNECTION_STRING ? 'Set' : 'NOT SET (check .env)'}`);
    console.log(`Google API Key in use: ${GOOGLE_API_KEY ? 'Set' : 'NOT SET (check .env)'}`);
    // Log the origins explicitly allowed by the server.js CORS config
    console.log(`CORS allowed origins in server.js: ${allowedOrigins.join(', ')}`);
});