
require("dotenv").config();

const express = require("express");
const http = require("http");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");

const registerQuizSocket = require("./sockets/quizSocket");
const registerWordChainSocket = require("./sockets/wordChainSocket");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;

const allowedOrigins = (process.env.FRONTEND_URL || "*")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

const corsOrigin = allowedOrigins.includes("*")
    ? true
    : allowedOrigins;

app.use(cors({
    origin: corsOrigin,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
}));

app.use(express.json());

// ========================================
// SOCKET.IO
// ========================================

const io = new Server(server, {
    cors: {
        origin: corsOrigin,
        methods: ["GET", "POST"],
        credentials: true,
    },
});

// ========================================
// JWT AUTH
// ========================================

io.use((socket, next) => {
    try {
        const token = socket.handshake.auth?.token;

        if (!token) {
            return next(new Error("Vui lòng đăng nhập."));
        }

        if (!process.env.JWT_SECRET) {
            return next(new Error("Thiếu JWT_SECRET."));
        }

        const decoded = jwt.verify(
            token,
            process.env.JWT_SECRET
        );

        const userId =
            decoded.id ??
            decoded.userId ??
            decoded.user_id ??
            decoded.sub;

        if (!userId) {
            return next(new Error("Token không có user ID."));
        }

        socket.data.userId = String(userId);

        next();
    } catch (error) {
        console.error("Socket authentication:", error.message);
        next(new Error("Token không hợp lệ hoặc hết hạn."));
    }
});

// ========================================
// REGISTER SOCKET
// ========================================

const quizSocket = registerQuizSocket(io);
const wordChainSocket = registerWordChainSocket(io);

console.log("Quiz Socket: READY");
console.log("Word Chain Socket: READY");

// ========================================
// HTTP
// ========================================

app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "Game Socket Server is running.",
        services: [
            "Quiz Multiplayer",
            "Word Chain Multiplayer",
        ],
    });
});

app.get("/health", (req, res) => {
    res.json({
        success: true,
        service: "game-socket-server",
        timestamp: new Date().toISOString(),
    });
});

app.get("/rooms-status", (req, res) => {
    res.json({
        success: true,
        game: "quiz",
        ...quizSocket.getRoomStatus(),
    });
});

app.get("/word-chain-rooms-status", (req, res) => {
    res.json({
        success: true,
        game: "word-chain",
        ...wordChainSocket.getRoomStatus(),
    });
});

app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: "API không tồn tại.",
        path: req.originalUrl,
    });
});

server.listen(PORT, "0.0.0.0", () => {
    console.log("--------------------------------");
    console.log(`Server running on port ${PORT}`);
    console.log("Quiz Multiplayer: READY");
    console.log("Word Chain Multiplayer: READY");
    console.log("--------------------------------");
});
