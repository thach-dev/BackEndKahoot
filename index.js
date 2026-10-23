
require("dotenv").config();

const express = require("express");
const http = require("http");
const cors = require("cors");
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

// Đăng ký các sự kiện Socket.IO
const quizSocket = registerQuizSocket(io);

app.get("/rooms-status", (_req, res) => {
  res.json({
    success: true,
    ...quizSocket.getRoomStatus(),
  });
});

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

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Quiz Socket Server listening on port ${PORT}`);
});