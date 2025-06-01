// Import necessary modules
const express = require('express');
const cors = require('cors'); // Middleware for enabling Cross-Origin Resource Sharing
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
        console.error('MongoDB connection error:', err);
        // Exit the application if database connection fails, as it's critical
        process.exit(1);
    });

// Define the Mongoose schema for chat sessions
const chatSchema = new mongoose.Schema({
    sessionId: {
        type: String,
        required: true,
        unique: true // Ensure each session ID is unique
    },
    history: [{ // Array to store conversation turns
        role: {
            type: String, // 'user' or 'model' (as per Gemini API roles)
            required: true
        },
        text: {
            type: String,
            required: true
        },
        timestamp: {
            type: Date,
            default: Date.now // Automatically set creation time for each message
        }
    }],
    jobTitle: {
        type: String, // The job title for which the interview is conducted
        required: true // Job title is essential for interview context
    },
    createdAt: {
        type: Date,
        default: Date.now // Timestamp for when the session was first created
    },
    updatedAt: { // Add an 'updatedAt' field for tracking last modification
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
const port = process.env.PORT || 3000; // Use port from .env or default to 3000

// --- CORS Configuration ---
// Define allowed origins for Cross-Origin Resource Sharing.
// This is crucial for security and allowing your frontend to communicate.
const allowedOrigins = [
    'http://localhost:5173', // Default Vite dev server port for your React frontend
    // Add other local development origins if necessary (e.g., 'http://localhost:3000')
    // In production, uncomment and add your deployed frontend's URL:
    // 'https://your-deployed-frontend-domain.com'
];

const corsOptions = {
    origin: function (origin, callback) {
        // Allow requests with no origin (e.g., same-origin requests, mobile apps, Postman/curl)
        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
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
    process.exit(1); // Exit if API key is missing
}
const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);

// --- API Routes ---

/**
 * POST /api/interview
 * Main endpoint for managing mock interview conversations.
 * It fetches/creates a chat session, interacts with the Gemini AI,
 * updates the conversation history, and saves it to MongoDB.
 *
 * Request Body:
 * {
 * sessionId: string,    // Unique ID for the current interview session
 * jobTitle: string,     // The job title for which the interview is being conducted
 * userResponse: string  // The user's latest response or an empty string for the initial prompt
 * }
 *
 * Response Body:
 * {
 * response: string,                 // The AI's latest response
 * history: Array<{ role: string, text: string, timestamp: Date }> // Full conversation history
 * }
 */
app.post('/api/interview', async (req, res) => {
    const { sessionId, jobTitle, userResponse } = req.body;

    // Basic input validation
    if (!sessionId || !jobTitle || userResponse === undefined) {
        return res.status(400).json({ error: 'Missing sessionId, jobTitle, or userResponse in request body.' });
    }

    let chatSession;
    try {
        // Find an existing chat session by sessionId in the database
        chatSession = await ChatSession.findOne({ sessionId });

        // If no session exists, create a new one
        if (!chatSession) {
            chatSession = new ChatSession({ sessionId, jobTitle, history: [] });
            console.log(`New session created for ID: ${sessionId}`);
        } else {
            // If session exists, update jobTitle (in case it changed or was refined)
            chatSession.jobTitle = jobTitle;
            console.log(`Existing session found for ID: ${sessionId}`);
        }
    } catch (dbError) {
        console.error('Database find/create operation failed:', dbError);
        return res.status(500).json({ error: 'Failed to access chat session in database.' });
    }

    // Get the current conversation history from the database object
    // This `history` variable is the one stored in MongoDB
    let history = chatSession.history;

    try {
        // Configure the Gemini model
        const model = genAI.getGenerativeModel({
            model: "gemini-1.5-flash", // Using the flash model for potentially faster responses
            systemInstruction: { // Instructions for the AI's persona and task
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
                responseMimeType: "text/plain", // Ensure response is plain text
            },
        });

        // Prepare the history array specifically for the Gemini API's `startChat` method.
        // This array must always start with a 'user' role.
        let historyForGemini = history.map(item => ({
            role: item.role,
            parts: [{ text: item.text }]
        }));

        let messageToSendToGemini = userResponse; // The actual message to send to Gemini for the current turn

        // --- Crucial Logic for Handling Initial Interview Start ---
        // If it's the very first request (history from DB is empty),
        // we need to inject an implicit 'user' message to properly start the Gemini chat.
        if (history.length === 0) {
            // The frontend sends userResponse: '' to trigger the start.
            // We use a predefined prompt as the effective 'user' input for this first turn.
            messageToSendToGemini = userResponse || "start a mock interview"; // Use this as the "user's" first message to Gemini
            // At this point, we DO NOT add this to `chatSession.history` yet.
            // We'll add it after getting the AI's first response, ensuring correct order.
        } else {
            // For subsequent turns (history is not empty), the user's actual response
            // is added to the session history immediately. This ensures the 'user' role
            // is correctly placed before the 'model' role in the persisted history.
            chatSession.history.push({ role: 'user', text: userResponse });
            // Also, add it to the temporary array being prepared for the current Gemini API call.
            historyForGemini.push({ role: 'user', parts: [{ text: userResponse }] });
        }
        // --- End Crucial Logic for Handling Initial Interview Start ---

        // Start a new chat session with the model, providing the correctly formatted history.
        const chat = model.startChat({
            history: historyForGemini
        });

        // Send the appropriate message (either the user's actual response or the initial prompt) to Gemini.
        const apiResponse = await chat.sendMessageStream(messageToSendToGemini);

        let fullResponse = '';
        // Process the streamed response from the AI.
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

        // --- Final History Update Logic for Persistence ---
        // If the `chatSession.history` was empty before this turn (meaning it was the initial request),
        // we now explicitly add the user's initial *implicit* prompt, followed by the AI's first question.
        // This ensures the history stored in MongoDB correctly begins with a 'user' role.
        if (history.length === 0) {
            chatSession.history.push({ role: 'user', text: messageToSendToGemini });
        }
        // Always add the AI's response to the conversation history.
        chatSession.history.push({ role: 'model', text: fullResponse });
        // --- End Final History Update Logic for Persistence ---

        // Save the updated conversation history to MongoDB.
        await chatSession.save();

        // Send the AI's latest response and the full updated history back to the frontend.
        res.json({ response: fullResponse, history: chatSession.history });

    } catch (error) {
        console.error('Error during Gemini API call or session saving:', error);
        // Provide a more informative error message to the frontend.
        res.status(500).json({ error: 'Failed to process interview request or get AI response. Please check backend logs for details.' });
    }
});

// --- Server Start ---
app.listen(port, () => {
    console.log(`Backend server running on http://localhost:${port}`);
    console.log(`MongoDB connection string in use: ${DB_CONNECTION_STRING ? 'Set' : 'NOT SET (check .env)'}`);
    console.log(`Google API Key in use: ${GOOGLE_API_KEY ? 'Set' : 'NOT SET (check .env)'}`);
    console.log(`CORS allowed origins: ${allowedOrigins.join(', ')}`);
});