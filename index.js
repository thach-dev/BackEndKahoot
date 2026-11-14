
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

// ========================================
// CORS
// ========================================

const allowedOrigins = (
    process.env.FRONTEND_URL || "*"
)
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);

const corsOrigin = allowedOrigins.includes("*")
    ? true
    : allowedOrigins;

app.use(
    cors({
        origin: corsOrigin,
        methods: [
            "GET",
            "POST",
            "PUT",
            "PATCH",
            "DELETE",
            "OPTIONS",
        ],
        allowedHeaders: [
            "Content-Type",
            "Authorization",
        ],
        credentials: true,
    })
);

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

    transports: ["websocket", "polling"],

    pingInterval: 25000,
    pingTimeout: 20000,
    connectTimeout: 20000,
});

// ========================================
// JWT AUTHENTICATION
// ========================================

io.use((socket, next) => {
    try {
        console.log("\n========== SOCKET AUTH ==========");
        console.log("Socket ID:", socket.id);
        console.log("Origin:", socket.handshake.headers.origin);

        const token = socket.handshake.auth?.token;

        if (!token) {
            console.log("AUTH ERROR: TOKEN_MISSING");
            return next(new Error("TOKEN_MISSING"));
        }

        if (!process.env.JWT_SECRET) {
            console.log("AUTH ERROR: JWT_SECRET_MISSING");
            return next(new Error("JWT_SECRET_MISSING"));
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
            console.log("AUTH ERROR: USER_ID_MISSING");
            return next(new Error("USER_ID_MISSING"));
        }

        socket.data.userId = String(userId);
        socket.data.user = decoded;

        console.log("AUTH SUCCESS");
        console.log("User ID:", socket.data.userId);
        console.log("=================================\n");

        return next();
    } catch (error) {
        console.error("SOCKET AUTH FAILED:", error.message);

        if (error.name === "TokenExpiredError") {
            return next(new Error("TOKEN_EXPIRED"));
        }

        if (error.name === "JsonWebTokenError") {
            return next(new Error("TOKEN_INVALID"));
        }

        return next(new Error("AUTH_FAILED"));
    }
});

// ========================================
// REGISTER QUIZ SOCKET
// ========================================

const quizSocket = registerQuizSocket(io);

console.log("Quiz Socket: READY");

// ========================================
// REGISTER WORD CHAIN SOCKET
// ========================================

const wordChainSocket = registerWordChainSocket(io);

console.log("Word Chain Socket: READY");

// ========================================
// GENERAL SOCKET EVENTS
// ========================================

io.on("connection", (socket) => {
    console.log("SOCKET CONNECTED:", {
        socketId: socket.id,
        userId: socket.data.userId,
    });

    socket.on("disconnect", (reason) => {
        console.log("SOCKET DISCONNECTED:", {
            socketId: socket.id,
            userId: socket.data.userId,
            reason,
        });
    });

    socket.on("error", (error) => {
        console.error("SOCKET ERROR:", error);
    });
});

// ========================================
// HOME
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

// ========================================
// HEALTH
// ========================================

app.get("/health", (req, res) => {
    res.json({
        success: true,
        service: "game-socket-server",
        status: "healthy",
        timestamp: new Date().toISOString(),
    });
});

// ========================================
// QUIZ ROOM STATUS
// ========================================

app.get("/rooms-status", (req, res) => {
    try {
        res.json({
            success: true,
            game: "quiz",
            ...quizSocket.getRoomStatus(),
        });
    } catch (error) {
        console.error("QUIZ ROOM STATUS ERROR:", error);

        res.status(500).json({
            success: false,
            message: "Không thể lấy trạng thái phòng Quiz.",
        });
    }
});

// ========================================
// WORD CHAIN ROOM STATUS
// ========================================

app.get("/word-chain-rooms-status", (req, res) => {
    try {
        res.json({
            success: true,
            game: "word-chain",
            ...wordChainSocket.getRoomStatus(),
        });
    } catch (error) {
        console.error("WORD CHAIN ROOM STATUS ERROR:", error);

        res.status(500).json({
            success: false,
            message: "Không thể lấy trạng thái phòng Nối Từ.",
        });
    }
});

// ========================================
// 404
// ========================================

app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: "API không tồn tại.",
        path: req.originalUrl,
    });
});

// ========================================
// GLOBAL ERROR HANDLER
// ========================================

app.use((error, req, res, next) => {
    console.error("SERVER ERROR:", error);

    res.status(500).json({
        success: false,
        message: "Lỗi máy chủ.",
    });
});

// ========================================
// START SERVER
// ========================================

server.listen(PORT, "0.0.0.0", () => {
    console.log("--------------------------------");
    console.log(`Server running on port ${PORT}`);
    console.log("Quiz Multiplayer: READY");
    console.log("Word Chain Multiplayer: READY");
    console.log("Socket.IO: READY");
    console.log("--------------------------------");
});

// ========================================
// SERVER ERRORS
// ========================================

server.on("error", (error) => {
    console.error("HTTP SERVER ERROR:", error);
});

process.on("unhandledRejection", (reason) => {
    console.error("UNHANDLED REJECTION:", reason);
});

process.on("uncaughtException", (error) => {
    console.error("UNCAUGHT EXCEPTION:", error);
});
