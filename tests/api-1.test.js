// tests/api-1.test.js

const request = require('supertest');
const mongoose = require('mongoose'); // Keep this, as we're mocking it

// Mongoose mock adjusted - IMPORTANT CHANGES HERE
jest.mock('mongoose', () => {
    const actualMongoose = jest.requireActual('mongoose');

    // Store a reference to the mocked constructor for its methods (like findOne)
    let mockChatSessionConstructorReference;

    // Mock the constructor itself
    const mockChatSessionConstructor = jest.fn(function(data) {
        // This 'this' refers to the instance created by `new ChatSession(data)`
        this.sessionId = data ? data.sessionId : undefined;
        this.jobTitle = data ? data.jobTitle : undefined;
        this.history = data ? (data.history ? [...data.history] : []) : []; // Deep copy history for new instances
        this.save = jest.fn(() => Promise.resolve(this)); // Mock save on the instance
        return this; // Return the instance
    });

    // Attach static methods directly to the mocked constructor
    mockChatSessionConstructor.findOne = jest.fn();

    // Store the reference to the constructor mock for later use in beforeEach/afterEach
    mockChatSessionConstructorReference = mockChatSessionConstructor;

    return {
        ...actualMongoose, // Keep actual Schema and other non-mocked parts
        connect: jest.fn(() => Promise.resolve()),
        model: jest.fn((name, schema) => {
            // When mongoose.model is called, return our mocked constructor
            return mockChatSessionConstructorReference;
        }),
        // Explicitly mock mongoose.connection for the `afterAll` cleanup
        connection: {
            readyState: 1, // Simulate connected state by default
            disconnect: jest.fn(() => Promise.resolve())
        },
        Schema: actualMongoose.Schema, // Use the actual Schema
    };
});

// REFINED GoogleGenerativeAI MOCK
const mockSendMessageStream = jest.fn();
const mockStartChat = jest.fn(() => ({
    sendMessageStream: mockSendMessageStream
}));
const mockGetGenerativeModel = jest.fn(() => ({
    startChat: mockStartChat
}));

const mockGenAIInstance = {
    getGenerativeModel: mockGetGenerativeModel
};

jest.mock('@google/generative-ai', () => {
    return {
        GoogleGenerativeAI: jest.fn(() => mockGenAIInstance)
    };
});
// ***************************************************************


// Import `server.js` now.
const app = require('../server');
// If server.js exports a serverInstance, grab it to close it later.
const serverInstance = app.serverInstance; // This will be undefined in tests, which is fine for supertest

// Get reference to our mocked Mongoose model (which is the mocked constructor)
const ChatSession = mongoose.model('ChatSession');

describe('API: Interview Endpoint (/api/interview)', () => {

    // Before each test, reset mocks and ensure a clean state
    beforeEach(() => {
        // Spy on console.log and console.error to suppress them during tests
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});

        // Clear all mock calls on specific functions and constructors
        jest.clearAllMocks(); // This clears calls on ChatSession.findOne and ChatSession constructor itself

        // Clear mocks for Google Generative AI components
        mockGetGenerativeModel.mockClear();
        mockStartChat.mockClear();
        mockSendMessageStream.mockClear();

        // Clear mocks for Mongoose components (though jest.clearAllMocks covers most)
        mongoose.connect.mockClear();
        mongoose.connection.disconnect.mockClear();
        // The ChatSession constructor and its static methods are cleared by clearAllMocks if they are part of the mock

        // Default mock for findOne: session not found initially
        ChatSession.findOne.mockResolvedValue(null);

        // Reset the default readyState for mongoose connection
        mongoose.connection.readyState = 1;

        // Configure the mocked Gemini API response
        mockSendMessageStream.mockImplementation(async (message) => {
            let responseText = '';
            if (message === "start a mock interview") {
                responseText = "Tell me about yourself.";
            } else if (message === "I'm a data scientist with a background in machine learning.") { // Specific user response for this test
                responseText = "Your skills are good. What is your experience?";
            } else if (message === "Tell me about my skills.") { // Example for specific user input
                responseText = "Your skills are good. What is your experience?";
            } else if (message === "I'm a software engineer with 5 years experience.") { // Example for specific user input
                responseText = "That's great. Can you tell me about your biggest challenge?";
            } else {
                responseText = "Thank you for your response. What's next?"; // Generic fallback
            }

            // Simulate streaming by generating chunks
            const chunks = responseText.split(' ').map(word => ({ text: () => word + ' ' }));
            chunks.push({ text: () => '' }); // Final empty chunk for stream end

            // Return an async iterator for the stream
            return {
                stream: (async function* () {
                    for (const chunk of chunks) {
                        yield chunk;
                    }
                })()
            };
        });
    });

    // After each test, restore the original console.log and console.error implementations
    afterEach(() => {
        jest.restoreAllMocks();
    });

    // Clean up: Close the server after all tests are done
    afterAll(async () => {
        if (mongoose.connection.readyState === 1) { // 1 means connected
            await mongoose.disconnect();
        }
        // If serverInstance was actually created (when server.js runs as main), close it.
        // Supertest handles its own server, so serverInstance is usually undefined in tests, which is fine.
        if (serverInstance && serverInstance.listening) {
            await new Promise(resolve => serverInstance.close(resolve));
        }
    });


    // --- Positive Scenarios ---

    test('should start a new interview session and return initial question', async () => {
        const sessionId = 'test-session-1';
        const jobTitle = 'Software Engineer';
        const userResponse = ''; // Initial empty response to trigger first question

        const res = await request(app)
            .post('/api/interview')
            .send({ sessionId, jobTitle, userResponse });

        expect(res.statusCode).toEqual(200);
        expect(res.body).toHaveProperty('response');
        expect(res.body.response).toContain('Tell me about yourself.');
        expect(res.body.history).toHaveLength(2); // user's initial "start a mock interview" + model's question
        expect(res.body.history[0].role).toBe('user');
        expect(res.body.history[0].text).toBe('start a mock interview');
        expect(res.body.history[1].role).toBe('model');
        expect(res.body.history[1].text).toContain('Tell me about yourself.');

        expect(ChatSession.findOne).toHaveBeenCalledWith({ sessionId });
        // The ChatSession constructor should be called exactly once for a new session
        expect(ChatSession).toHaveBeenCalledTimes(1);
        expect(ChatSession.mock.calls[0][0].jobTitle).toBe(jobTitle);
        // Get the instance created by the server and check its save method
        const createdSessionInstance = ChatSession.mock.results[0].value;
        expect(createdSessionInstance.save).toHaveBeenCalledTimes(1);
    });

    test('should continue an existing interview session with user response', async () => {
        const sessionId = 'test-session-2';
        const jobTitle = 'Data Scientist';
        const initialHistory = [
            { role: 'user', text: 'start a mock interview' },
            { role: 'model', text: 'Tell me about yourself.' }
        ];
        // This user response now has a specific mock for it
        const userResponse = "I'm a data scientist with a background in machine learning.";

        // Mock findOne to return an existing session
        // Make sure the mock object has a save method, as the server will call it
        const existingSessionMock = {
            sessionId,
            jobTitle,
            history: [...initialHistory], // IMPORTANT: Copy the array
            save: jest.fn(function() { return Promise.resolve(this); }), // Mock save on this specific existing session object, returning `this` for updated history
        };
        ChatSession.findOne.mockResolvedValue(existingSessionMock);

        const res = await request(app)
            .post('/api/interview')
            .send({ sessionId, jobTitle, userResponse });

        expect(res.statusCode).toEqual(200);
        expect(res.body).toHaveProperty('response');
        expect(res.body.response).toContain('What is your experience?');
        // Corrected expectation for history length: initial (2) + user (1) + model (1) = 4
        expect(res.body.history).toHaveLength(4); // Changed from initialHistory.length + 2 to 4
        expect(res.body.history[initialHistory.length].role).toBe('user'); // Index 2
        expect(res.body.history[initialHistory.length].text).toBe(userResponse);
        expect(res.body.history[initialHistory.length + 1].role).toBe('model'); // Index 3
        expect(res.body.history[initialHistory.length + 1].text).toContain('What is your experience?');

        expect(ChatSession.findOne).toHaveBeenCalledWith({ sessionId });
        expect(existingSessionMock.save).toHaveBeenCalledTimes(1);
        expect(ChatSession).not.toHaveBeenCalled(); // Ensure constructor is not called for existing session
    });

    // --- Negative Scenarios ---

    test('should return 400 for missing sessionId', async () => {
        const res = await request(app)
            .post('/api/interview')
            .send({ jobTitle: 'Developer', userResponse: 'hello' });

        expect(res.statusCode).toEqual(400);
        expect(res.body.error).toEqual('Missing sessionId, jobTitle, or userResponse in request body.');
    });

    test('should return 400 for missing jobTitle', async () => {
        const res = await request(app)
            .post('/api/interview')
            .send({ sessionId: 'test-session-missing-job', userResponse: 'hello' });

        expect(res.statusCode).toEqual(400);
        expect(res.body.error).toEqual('Missing sessionId, jobTitle, or userResponse in request body.');
    });

    test('should return 400 for missing userResponse', async () => {
        const res = await request(app)
            .post('/api/interview')
            .send({ sessionId: 'test-session-missing-response', jobTitle: 'Manager' });

        expect(res.statusCode).toEqual(400);
        expect(res.body.error).toEqual('Missing sessionId, jobTitle, or userResponse in request body.');
    });

    test('should return 500 if database operation fails', async () => {
        const sessionId = 'test-session-db-fail';
        const jobTitle = 'Engineer';
        const userResponse = 'initial';

        ChatSession.findOne.mockRejectedValue(new Error('Database connection lost'));

        const res = await request(app)
            .post('/api/interview')
            .send({ sessionId, jobTitle, userResponse });

        expect(res.statusCode).toEqual(500);
        expect(res.body.error).toEqual('Failed to access chat session in database.');
        expect(ChatSession.findOne).toHaveBeenCalledWith({ sessionId });
    });

    test('should return 500 if Gemini API call fails', async () => {
        const sessionId = 'test-session-gemini-fail';
        const jobTitle = 'Designer';
        const userResponse = 'tell me about yourself';

        // Mock Gemini API to throw an error
        mockSendMessageStream.mockImplementation(async () => {
            throw new Error('Gemini API rate limit exceeded');
        });

        const res = await request(app)
            .post('/api/interview')
            .send({ sessionId, jobTitle, userResponse });

        expect(res.statusCode).toEqual(500);
        expect(res.body.error).toEqual('Failed to process interview request or get AI response. Please check backend logs for details.');
        expect(mockSendMessageStream).toHaveBeenCalled();
    });

    test('should handle empty user response after initial question', async () => {
        const sessionId = 'test-session-empty-followup';
        const jobTitle = 'Frontend Developer';
        const initialHistory = [
            { role: 'user', text: 'start a mock interview' },
            { role: 'model', text: 'Tell me about yourself.' }
        ];
        const userResponse = ''; // Empty response after initial question

        const existingSessionMock = {
            sessionId,
            jobTitle,
            history: [...initialHistory], // IMPORTANT: Copy the array
            save: jest.fn(function() { return Promise.resolve(this); }),
        };
        ChatSession.findOne.mockResolvedValue(existingSessionMock);


        const res = await request(app)
            .post('/api/interview')
            .send({ sessionId, jobTitle, userResponse });

        expect(res.statusCode).toEqual(200);
        expect(res.body.response).toContain('Thank you for your response.');
        // Corrected expected history length based on initial history (2) + user (1) + model (1) = 4
        expect(res.body.history.length).toBe(4); // Changed from initialHistory.length + 2 to 4
        expect(res.body.history[initialHistory.length].text).toBe(userResponse); // User's empty response is recorded. Index 2.
        expect(existingSessionMock.save).toHaveBeenCalledTimes(1);
    });

    test('should ensure history is correctly passed to Gemini and updated', async () => {
        const sessionId = 'test-session-history';
        const jobTitle = 'Product Manager';
        const initialHistory = [
            { role: 'user', text: 'start interview' },
            { role: 'model', text: 'Tell me about yourself.' },
            { role: 'user', text: 'I manage products.' },
            { role: 'model', text: 'What methodologies do you use?' }
        ];
        const userResponse = 'Agile and Scrum.';

        const existingSessionMock = {
            sessionId,
            jobTitle,
            // Deep copy history to ensure it's not modified by the mock directly
            history: JSON.parse(JSON.stringify(initialHistory)),
            save: jest.fn(function() { return Promise.resolve(this); }), // `this` will be the modified session object
        };
        ChatSession.findOne.mockResolvedValue(existingSessionMock);

        const res = await request(app)
            .post('/api/interview')
            .send({ sessionId, jobTitle, userResponse });

        expect(res.statusCode).toEqual(200);
        expect(mockGetGenerativeModel).toHaveBeenCalledTimes(1);
        expect(mockGetGenerativeModel.mock.calls[0][0].model).toBe("gemini-1.5-flash");
        expect(mockGetGenerativeModel.mock.calls[0][0].systemInstruction.parts[0].text).toContain(`interviewer for a job titled "${jobTitle}"`);

        // Prepare the history that *should* be passed to model.startChat
        // This should be the initial history *before* the current user's message is added.
        const expectedGeminiStartChatHistory = initialHistory.map(item => ({
            role: item.role,
            parts: [{ text: item.text }]
        }));

        expect(mockStartChat).toHaveBeenCalledWith({
            history: expect.arrayContaining(expectedGeminiStartChatHistory)
        });

        // Check that `sendMessageStream` received the correct current user message
        expect(mockSendMessageStream).toHaveBeenCalledWith(userResponse);

        // Check that the saved history includes the new turn (user and model responses)
        expect(existingSessionMock.history.length).toBe(initialHistory.length + 2);
        expect(existingSessionMock.history[existingSessionMock.history.length - 2].role).toBe('user');
        expect(existingSessionMock.history[existingSessionMock.history.length - 2].text).toBe(userResponse);
        expect(existingSessionMock.history[existingSessionMock.history.length - 1].role).toBe('model');
        expect(existingSessionMock.history[existingSessionMock.history.length - 1].text).toContain('Thank you for your response. What\'s next?'); // Based on mock logic
    });
});
