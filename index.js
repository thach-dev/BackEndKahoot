
require("dotenv").config();

const express = require("express");
const http = require("http");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");

const registerQuizSocket = require("./sockets/quizSocket");

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

app.use(cors({ origin: corsOrigin }));
app.use(express.json());

const io = new Server(server, {
  cors: {
    origin: corsOrigin,
    methods: ["GET", "POST"],
  },
});

// ==========================================
// JWT AUTHENTICATION FOR SOCKET.IO
// ==========================================
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

    // Hỗ trợ các tên trường ID thường gặp trong JWT.
    const userId =
      decoded.id ??
      decoded.userId ??
      decoded.user_id ??
      decoded.sub;

    if (userId === undefined || userId === null || userId === "") {
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

// ==========================================
// REGISTER QUIZ SOCKET EVENTS
// ==========================================
const quizSocket = registerQuizSocket(io);

// ==========================================
// HTTP ROUTES
// ==========================================
app.get("/", (_req, res) => {
  res.json({
    message: "Quiz Socket Server is running",
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "quiz-socket-server",
    timestamp: new Date().toISOString(),
  });
});

app.get("/rooms-status", (_req, res) => {
  res.json({
    success: true,
    ...quizSocket.getRoomStatus(),
  });
});

// ==========================================
// START SERVER
// ==========================================
server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Quiz Socket Server listening on port ${PORT}`
  );
});
