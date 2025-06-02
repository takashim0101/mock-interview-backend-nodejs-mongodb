// C:\Level 5\Mission 3_1\mock-interview-backend-nodejs-mongodb\tests\api-1.test.js

const request = require('supertest');
const mongoose = require('mongoose');

// --- REFINED Mongoose Mocking ---
// This mock needs to precisely control the ChatSession model's behavior,
// including its constructor, static methods (like findOne), and instance methods (like save).
jest.mock('mongoose', () => {
    const actualMongoose = jest.requireActual('mongoose'); // Get real Mongoose for non-mocked parts

    // Define a mock constructor for ChatSession
    const mockChatSessionConstructor = jest.fn(function(data) {
        // This 'this' refers to the instance created by `new ChatSession(data)`
        this.sessionId = data.sessionId;
        this.jobTitle = data.jobTitle;
        this.history = data.history ? [...data.history] : []; // Ensure history is copied for new instances
        // Mock save() for THIS specific instance, resolving with the instance itself
        this.save = jest.fn().mockResolvedValue(this);
        return this; // Return the created instance
    });

    // Attach static methods directly to the mocked constructor
    mockChatSessionConstructor.findOne = jest.fn();
    // If you had other static methods like .create(), you'd mock them here:
    // mockChatSessionConstructor.create = jest.fn();

    return {
        ...actualMongoose, // Keep actual Schema and other non-mocked parts of mongoose
        connect: jest.fn(() => Promise.resolve()), // Mock connect to always succeed
        // When mongoose.model is called, return our mocked ChatSession constructor
        model: jest.fn((name, schema) => {
            if (name === 'ChatSession') { // Ensure we're returning the right mock for ChatSession
                return mockChatSessionConstructor;
            }
            // If you had other models, you'd return other mocks here
            return actualMongoose.model(name, schema); // Fallback for other models
        }),
        // Explicitly mock mongoose.connection for the `afterAll` cleanup
        connection: {
            readyState: 1, // Simulate connected state by default
            disconnect: jest.fn(() => Promise.resolve()) // Mock disconnect to always succeed
        },
        Schema: actualMongoose.Schema, // Use the actual Schema constructor
    };
});


// --- REFINED GoogleGenerativeAI MOCK ---
// Define mocks for the methods that will be called.
const mockSendMessageStream = jest.fn(); // This is the core mock for stream behavior, will be overridden
const mockStartChat = jest.fn(() => ({
    sendMessageStream: mockSendMessageStream // Point sendMessageStream to our changeable mock
}));
const mockGetGenerativeModel = jest.fn(() => ({
    startChat: mockStartChat
}));

jest.mock('@google/generative-ai', () => {
    return {
        // The GoogleGenerativeAI constructor itself.
        // It should return an object that has getGenerativeModel.
        GoogleGenerativeAI: jest.fn(() => ({
            getGenerativeModel: mockGetGenerativeModel // Point getGenerativeModel to our mock
        }))
    };
});
// ***************************************************************


// Import `server.js` now. This ensures mocks are applied before server.js is loaded.
const app = require('../server');
// The serverInstance is typically undefined in test contexts when using supertest, which is fine.
const serverInstance = app.serverInstance;

// Get reference to our mocked Mongoose model (which is the mocked constructor)
const ChatSession = mongoose.model('ChatSession');

describe('API: Interview Endpoint (/api/interview)', () => {

    // Before each test, reset mocks and ensure a clean state
    beforeEach(() => {
        // Spy on console.log and console.error to suppress them during tests
        // This prevents test output from being cluttered by server logs.
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});

        // Clear all mock calls on specific functions and constructors.
        // This is crucial to ensure tests are isolated and don't affect each other.
        jest.clearAllMocks(); // Clears calls on ChatSession.findOne, ChatSession constructor, instance.save(), etc.

        // Default mock for findOne: session not found initially.
        // This ensures the first test (new session) works as expected.
        ChatSession.findOne.mockResolvedValue(null);

        // Reset the default readyState for mongoose connection (important if tests change it).
        mongoose.connection.readyState = 1;

        // Configure the DEFAULT mocked Gemini API response for passing scenarios.
        // This mock will be used unless explicitly overridden in a specific test.
        mockSendMessageStream.mockImplementation(async (message) => {
            let responseText = '';
            if (message === "start a mock interview") {
                responseText = "Tell me about yourself.";
            } else if (message === "I'm a data scientist with a background in machine learning.") {
                responseText = "Your skills are good. What is your experience?";
            } else if (message === "Tell me about my skills.") {
                responseText = "Your skills are good. What is your experience?";
            } else if (message === "I'm a software engineer with 5 years experience.") {
                responseText = "That's great. Can you tell me about your biggest challenge?";
            } else {
                responseText = "Thank you for your response. What's next?"; // Generic fallback for other inputs
            }

            // Simulate streaming by generating chunks.
            const chunks = responseText.split(' ').map(word => ({ text: () => word + ' ' }));
            chunks.push({ text: () => '' }); // Final empty chunk to signal stream end

            // Return an async iterator for the stream, as expected by `for await (const chunk of result.stream)`
            return {
                stream: (async function* () {
                    for (const chunk of chunks) {
                        yield chunk;
                    }
                })()
            };
        });
    });

    // After each test, restore the original console.log and console.error implementations.
    afterEach(() => {
        jest.restoreAllMocks();
    });

    // Clean up: Close the server and disconnect MongoDB after all tests are done.
    afterAll(async () => {
        if (mongoose.connection.readyState === 1) { // 1 means connected
            await mongoose.disconnect();
        }
        // If serverInstance was actually created (when server.js runs as main), close it.
        // Supertest handles its own server for tests, so serverInstance is usually undefined, which is fine.
        if (serverInstance && serverInstance.listening) {
            await new Promise(resolve => serverInstance.close(resolve));
        }
    });


    // --- Positive Scenarios ---

    test('should start a new interview session and return initial question', async () => {
        const sessionId = 'test-session-1';
        const jobTitle = 'Software Engineer';
        const userResponse = ''; // Initial empty response to trigger first question

        // ChatSession.findOne will return null due to beforeEach default,
        // so server.js will create a new session.

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

        // Verify that ChatSession.findOne was called to check for existing session
        expect(ChatSession.findOne).toHaveBeenCalledWith({ sessionId });
        // Verify that the ChatSession constructor was called exactly once for a new session
        expect(ChatSession).toHaveBeenCalledTimes(1);
        // Verify the jobTitle passed to the new ChatSession instance
        expect(ChatSession.mock.calls[0][0].jobTitle).toBe(jobTitle);

        // Retrieve the instance created by the mocked ChatSession constructor
        const createdSessionInstance = ChatSession.mock.results[0].value;
        // Verify that the save method was called on this newly created instance
        expect(createdSessionInstance.save).toHaveBeenCalledTimes(1);
    });

    test('should continue an existing interview session with user response', async () => {
        const sessionId = 'test-session-2';
        const jobTitle = 'Data Scientist';
        const initialHistory = [
            { role: 'user', text: 'start a mock interview' },
            { role: 'model', text: 'Tell me about yourself.' }
        ];
        const userResponse = "I'm a data scientist with a background in machine learning.";

        // Mock findOne to return an existing session.
        // IMPORTANT: The returned mock object must have a `save` method.
        const existingSessionMock = {
            sessionId,
            jobTitle,
            history: [...initialHistory], // Use spread to create a shallow copy
            save: jest.fn(function() { return Promise.resolve(this); }), // Mock save on this specific object
        };
        ChatSession.findOne.mockResolvedValue(existingSessionMock);

        const res = await request(app)
            .post('/api/interview')
            .send({ sessionId, jobTitle, userResponse });

        expect(res.statusCode).toEqual(200);
        expect(res.body).toHaveProperty('response');
        expect(res.body.response).toContain('What is your experience?');
        // Expected history length: initial (2) + user (1) + model (1) = 4
        expect(res.body.history).toHaveLength(initialHistory.length + 2);
        expect(res.body.history[initialHistory.length].role).toBe('user');
        expect(res.body.history[initialHistory.length].text).toBe(userResponse);
        expect(res.body.history[initialHistory.length + 1].role).toBe('model');
        expect(res.body.history[initialHistory.length + 1].text).toContain('What is your experience?');

        expect(ChatSession.findOne).toHaveBeenCalledWith({ sessionId });
        expect(existingSessionMock.save).toHaveBeenCalledTimes(1);
        // Ensure ChatSession constructor is NOT called for an existing session
        expect(ChatSession).not.toHaveBeenCalled();
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

        // Mock ChatSession.findOne to reject, simulating a database error
        ChatSession.findOne.mockRejectedValue(new Error('Database connection lost'));

        const res = await request(app)
            .post('/api/interview')
            .send({ sessionId, jobTitle, userResponse });

        expect(res.statusCode).toEqual(500);
        expect(res.body.error).toEqual('Failed to access chat session in database.');
        expect(ChatSession.findOne).toHaveBeenCalledWith({ sessionId });
        // Ensure no new session is attempted to be created or saved if findOne fails
        expect(ChatSession).not.toHaveBeenCalled();
    });

    test('should return 500 if Gemini API call fails', async () => {
        const sessionId = 'test-session-gemini-fail';
        const jobTitle = 'Designer';
        const userResponse = 'tell me about yourself';

        // Override the default mockSendMessageStream for THIS specific test to throw an error.
        mockSendMessageStream.mockImplementation(() => {
            throw new Error('Gemini API rate limit exceeded');
        });

        // Crucially, mock findOne to return an *existing* session.
        // This ensures the `else` block in `server.js` (where Gemini API is called) is executed.
        const existingSessionMock = {
            sessionId,
            jobTitle,
            // Provide some minimal history, as the `startChat` method expects it.
            history: [{ role: 'user', text: 'start interview' }, { role: 'model', text: 'Hi!' }],
            save: jest.fn().mockResolvedValue(this), // Mock save on this object to prevent further errors
        };
        ChatSession.findOne.mockResolvedValue(existingSessionMock);

        const res = await request(app)
            .post('/api/interview')
            .send({ sessionId, jobTitle, userResponse });

        expect(res.statusCode).toEqual(500);
        expect(res.body.error).toEqual('Failed to process interview request or get AI response. Please check backend logs for details.');
        // Verify that the mockSendMessageStream was indeed called, triggering the error.
        expect(mockSendMessageStream).toHaveBeenCalled();
        expect(ChatSession.findOne).toHaveBeenCalledWith({ sessionId });
        // Ensure that `save` was NOT called on the session, as the Gemini API failure should prevent it.
        expect(existingSessionMock.save).not.toHaveBeenCalled();
    });

    test('should handle empty user response after initial question', async () => {
        const sessionId = 'test-session-empty-followup';
        const jobTitle = 'Frontend Developer';
        const initialHistory = [
            { role: 'user', text: 'start a mock interview' },
            { role: 'model', text: 'Tell me about yourself.' }
        ];
        const userResponse = ''; // Empty response after initial question

        // Mock findOne to return an existing session for this continuation test.
        const existingSessionMock = {
            sessionId,
            jobTitle,
            history: [...initialHistory], // Copy initial history
            save: jest.fn(function() { return Promise.resolve(this); }),
        };
        ChatSession.findOne.mockResolvedValue(existingSessionMock);

        const res = await request(app)
            .post('/api/interview')
            .send({ sessionId, jobTitle, userResponse });

        expect(res.statusCode).toEqual(200);
        // Based on the default mock for sendMessageStream, it returns generic fallback.
        expect(res.body.response).toContain('Thank you for your response.');
        expect(res.body.history.length).toBe(initialHistory.length + 2); // Initial history + user + model response
        expect(res.body.history[initialHistory.length].text).toBe(userResponse); // User's empty response is recorded.
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

        // Mock findOne to return an existing session, ensuring history is deeply copied.
        const existingSessionMock = {
            sessionId,
            jobTitle,
            history: JSON.parse(JSON.stringify(initialHistory)), // Deep copy to prevent unintended modifications by mock
            save: jest.fn(function() { return Promise.resolve(this); }),
        };
        ChatSession.findOne.mockResolvedValue(existingSessionMock);

        const res = await request(app)
            .post('/api/interview')
            .send({ sessionId, jobTitle, userResponse });

        expect(res.statusCode).toEqual(200);
        expect(mockGetGenerativeModel).toHaveBeenCalledTimes(1);
        expect(mockGetGenerativeModel.mock.calls[0][0].model).toBe("gemini-1.5-flash");
        expect(mockGetGenerativeModel.mock.calls[0][0].systemInstruction.parts[0].text).toContain(`interviewer for a job titled "${jobTitle}"`);

        // Prepare the history that *should* be passed to model.startChat.
        // This is the history *before* the current user's message is added for Gemini's context.
        const expectedGeminiStartChatHistory = initialHistory.map(item => ({
            role: item.role,
            parts: [{ text: item.text }]
        }));

        expect(mockStartChat).toHaveBeenCalledWith({
            history: expect.arrayContaining(expectedGeminiStartChatHistory)
        });

        // Check that `sendMessageStream` received the correct current user message.
        expect(mockSendMessageStream).toHaveBeenCalledWith(userResponse);

        // Check that the saved history includes the new turn (user and model responses).
        expect(existingSessionMock.history.length).toBe(initialHistory.length + 2);
        expect(existingSessionMock.history[existingSessionMock.history.length - 2].role).toBe('user');
        expect(existingSessionMock.history[existingSessionMock.history.length - 2].text).toBe(userResponse);
        expect(existingSessionMock.history[existingSessionMock.history.length - 1].role).toBe('model');
        expect(existingSessionMock.history[existingSessionMock.history.length - 1].text).toContain('Thank you for your response. What\'s next?'); // Based on mock logic
    });
});
