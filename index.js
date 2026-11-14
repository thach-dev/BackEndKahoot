
require("dotenv").config();

const express = require("express");
const http = require("http");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");

// =====================================================
// IMPORT SOCKET
// =====================================================

const registerQuizSocket = require("./sockets/quizSocket");
const registerWordChainSocket = require("./sockets/wordChainSocket");

// =====================================================
// IMPORT ROUTES GAME NỐI TỪ
// =====================================================

const wordChainRoutes = require("./routes/wordChainRoutes");

// =====================================================
// INITIALIZE SERVER
// =====================================================

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;

// =====================================================
// CORS CONFIGURATION
// =====================================================

const allowedOrigins = (process.env.FRONTEND_URL || "*")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

const corsOrigin = allowedOrigins.includes("*")
    ? true
    : allowedOrigins;

app.use(
    cors({
        origin: corsOrigin,
        methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization"],
    })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =====================================================
// SOCKET.IO INITIALIZE
// =====================================================

const io = new Server(server, {
    cors: {
        origin: corsOrigin,
        methods: ["GET", "POST"],
        credentials: true,
    },
});

// =====================================================
// JWT AUTHENTICATION FOR SOCKET.IO
// Giữ nguyên cơ chế xác thực của Game Quiz
// =====================================================

io.use((socket, next) => {
    try {
        const token = socket.handshake.auth?.token;

        if (!token) {
            return next(new Error("Thiếu token đăng nhập."));
        }

        const secret = process.env.JWT_SECRET;

        if (!secret) {
            console.error(
                "Lỗi cấu hình: chưa có biến môi trường JWT_SECRET."
            );

            return next(
                new Error("Backend chưa cấu hình JWT_SECRET.")
            );
        }

        const decoded = jwt.verify(token, secret);

        const userId =
            decoded.id ??
            decoded.userId ??
            decoded.user_id ??
            decoded.sub;

        if (
            userId === undefined ||
            userId === null ||
            userId === ""
        ) {
            return next(
                new Error("Token không chứa ID người dùng.")
            );
        }

        socket.data.userId = String(userId);

        next();
    } catch (error) {
        console.error(
            "Socket JWT authentication failed:",
            error.message
        );

        return next(
            new Error("Token không hợp lệ hoặc đã hết hạn.")
        );
    }
});

// =====================================================
// REGISTER GAME QUIZ SOCKET
// =====================================================

const quizSocket = registerQuizSocket(io);

console.log("Quiz Socket registered successfully.");

// =====================================================
// REGISTER GAME NỐI TỪ SOCKET
// =====================================================

const wordChainSocket = registerWordChainSocket(io);

console.log("Word Chain Socket registered successfully.");

// =====================================================
// HTTP ROUTES
// =====================================================

// Trang chủ
app.get("/", (_req, res) => {
    res.json({
        success: true,
        message: "Game Server is running.",
        services: [
            "Quiz Multiplayer",
            "Word Chain Multiplayer",
        ],
    });
});

// Kiểm tra server
app.get("/health", (_req, res) => {
    res.json({
        ok: true,
        service: "game-socket-server",
        timestamp: new Date().toISOString(),
    });
});

// =====================================================
// QUIZ ROOM STATUS
// =====================================================

app.get("/rooms-status", (_req, res) => {
    res.json({
        success: true,
        game: "quiz",
        ...quizSocket.getRoomStatus(),
    });
});

// =====================================================
// WORD CHAIN ROOM STATUS
// =====================================================

app.get("/word-chain-rooms-status", (_req, res) => {
    res.json({
        success: true,
        game: "word-chain",
        ...wordChainSocket.getRoomStatus(),
    });
});

// =====================================================
// WORD CHAIN API
// Upload Excel, lấy danh sách bộ từ, xem chi tiết
// =====================================================

app.use("/api/word-chain", wordChainRoutes);

// =====================================================
// 404
// =====================================================

app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: "API không tồn tại.",
        path: req.originalUrl,
    });
});

// =====================================================
// ERROR HANDLER
// =====================================================

app.use((error, req, res, next) => {
    console.error("SERVER ERROR:", error);

    if (res.headersSent) {
        return next(error);
    }

    res.status(500).json({
        success: false,
        message: "Lỗi máy chủ.",
    });
});

// =====================================================
// START SERVER
// =====================================================

server.listen(PORT, "0.0.0.0", () => {
    console.log("------------------------------------");
    console.log(`Game Server listening on port ${PORT}`);
    console.log("Quiz Multiplayer: READY");
    console.log("Word Chain Multiplayer: READY");
    console.log("Socket.IO JWT Authentication: ENABLED");
    console.log("------------------------------------");
});
