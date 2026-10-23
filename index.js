
require("dotenv").config();

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;

const allowedOrigins = (process.env.FRONTEND_URL || "*")
  .split(",")
  .map((origin) => origin.trim());

app.use(cors({ origin: allowedOrigins.includes("*") ? true : allowedOrigins }));
app.use(express.json());

const io = new Server(server, {
  cors: {
    origin: allowedOrigins.includes("*") ? true : allowedOrigins,
    methods: ["GET", "POST"],
  },
});

const rooms = new Map();

app.get("/", (req, res) => {
  res.json({
    message: "Quiz Socket Server is running",
    rooms: rooms.size,
  });
});

function createPin() {
  let pin;

  do {
    pin = String(Math.floor(100000 + Math.random() * 900000));
  } while (rooms.has(pin));

  return pin;
}

function publicPlayers(room) {
  return room.players.map((player) => ({
    id: player.id,
    nickname: player.nickname,
    score: player.score,
  }));
}

function emitPlayers(pin, room) {
  io.to(pin).emit("room:players", publicPlayers(room));
}

function getRoom(pin) {
  return rooms.get(String(pin || ""));
}

// Host tạo phòng và gửi danh sách câu hỏi
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("host:create", (payload = {}, callback) => {
    const questions = payload.questions;

    if (!Array.isArray(questions) || questions.length === 0) {
      return callback?.({
        ok: false,
        message: "Vui lòng gửi danh sách câu hỏi.",
      });
    }

    const validQuestions = questions.filter(
      (q) =>
        q &&
        typeof q.question === "string" &&
        Array.isArray(q.options) &&
        q.options.length >= 2 &&
        Number.isInteger(q.correctAnswer)
    );

    if (validQuestions.length !== questions.length) {
      return callback?.({
        ok: false,
        message: "Dữ liệu câu hỏi không hợp lệ.",
      });
    }

    const pin = createPin();

    const room = {
      pin,
      hostId: socket.id,
      players: [],
      questions: validQuestions,
      currentIndex: -1,
      started: false,
      revealed: false,
      answers: new Map(),
    };

    rooms.set(pin, room);
    socket.join(pin);
    socket.data.hostPin = pin;

    callback?.({ ok: true, pin });
    console.log(`Room ${pin} created`);
  });

  socket.on("player:join", ({ pin, nickname } = {}, callback) => {
    const room = getRoom(pin);
    const name = String(nickname || "").trim().slice(0, 30);

    if (!room) {
      return callback?.({ ok: false, message: "Phòng không tồn tại." });
    }

    if (room.started) {
      return callback?.({ ok: false, message: "Trận đấu đã bắt đầu." });
    }

    if (!name) {
      return callback?.({ ok: false, message: "Vui lòng nhập biệt danh." });
    }

    if (room.players.some((player) => player.id === socket.id)) {
      return callback?.({ ok: false, message: "Bạn đã vào phòng rồi." });
    }

    room.players.push({
      id: socket.id,
      nickname: name,
      score: 0,
    });

    socket.join(room.pin);
    socket.data.playerPin = room.pin;

    emitPlayers(room.pin, room);
    callback?.({ ok: true, pin: room.pin });
  });

  socket.on("host:start", ({ pin } = {}, callback) => {
    const room = getRoom(pin);

    if (!room || room.hostId !== socket.id) {
      return callback?.({ ok: false, message: "Bạn không phải chủ phòng." });
    }

    if (room.started) {
      return callback?.({ ok: false, message: "Trận đấu đã bắt đầu." });
    }

    room.started = true;
    room.currentIndex = 0;
    room.revealed = false;
    room.answers.clear();

    io.to(room.pin).emit("game:started");
    io.to(room.pin).emit("question:show", {
      index: 0,
      total: room.questions.length,
      question: room.questions[0].question,
      options: room.questions[0].options,
    });

    callback?.({ ok: true });
  });

  socket.on("player:answer", ({ pin, answerIndex } = {}, callback) => {
    const room = getRoom(pin);

    if (!room || !room.started || room.revealed) {
      return callback?.({ ok: false, message: "Hiện không nhận câu trả lời." });
    }

    const player = room.players.find((item) => item.id === socket.id);

    if (!player) {
      return callback?.({ ok: false, message: "Bạn không thuộc phòng này." });
    }

    if (room.answers.has(socket.id)) {
      return callback?.({ ok: false, message: "Bạn đã trả lời câu này." });
    }

    const question = room.questions[room.currentIndex];

    if (
      !Number.isInteger(answerIndex) ||
      answerIndex < 0 ||
      answerIndex >= question.options.length
    ) {
      return callback?.({ ok: false, message: "Đáp án không hợp lệ." });
    }

    const correct = answerIndex === question.correctAnswer;

    room.answers.set(socket.id, {
      answerIndex,
      correct,
    });

    if (correct) {
      player.score += 100;
    }

    callback?.({ ok: true, correct });
    emitPlayers(room.pin, room);
  });

  socket.on("host:reveal-answer", ({ pin } = {}, callback) => {
    const room = getRoom(pin);

    if (!room || room.hostId !== socket.id || !room.started) {
      return callback?.({ ok: false, message: "Không thể công bố đáp án." });
    }

    if (room.revealed) {
      return callback?.({ ok: false, message: "Đáp án đã được công bố." });
    }

    room.revealed = true;

    const question = room.questions[room.currentIndex];

    io.to(room.pin).emit("question:result", {
      correctAnswer: question.correctAnswer,
      players: publicPlayers(room),
    });

    callback?.({ ok: true });
  });

  socket.on("host:next-question", ({ pin } = {}, callback) => {
    const room = getRoom(pin);

    if (!room || room.hostId !== socket.id || !room.started) {
      return callback?.({ ok: false, message: "Không thể chuyển câu hỏi." });
    }

    if (!room.revealed) {
      return callback?.({
        ok: false,
        message: "Hãy công bố đáp án trước.",
      });
    }

    const nextIndex = room.currentIndex + 1;

    if (nextIndex >= room.questions.length) {
      io.to(room.pin).emit("game:finished", {
        players: publicPlayers(room),
      });

      rooms.delete(room.pin);
      callback?.({ ok: true, finished: true });
      return;
    }

    room.currentIndex = nextIndex;
    room.revealed = false;
    room.answers.clear();

    const question = room.questions[nextIndex];

    io.to(room.pin).emit("question:show", {
      index: nextIndex,
      total: room.questions.length,
      question: question.question,
      options: question.options,
    });

    callback?.({ ok: true });
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);

    const hostPin = socket.data.hostPin;
    const hostRoom = getRoom(hostPin);

    if (hostRoom && hostRoom.hostId === socket.id) {
      io.to(hostPin).emit("room:closed", {
        message: "Chủ phòng đã ngắt kết nối.",
      });

      rooms.delete(hostPin);
    }

    const playerPin = socket.data.playerPin;
    const playerRoom = getRoom(playerPin);

    if (playerRoom) {
      playerRoom.players = playerRoom.players.filter(
        (player) => player.id !== socket.id
      );

      playerRoom.answers.delete(socket.id);
      emitPlayers(playerPin, playerRoom);
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Quiz Socket Server running on port ${PORT}`);
});
