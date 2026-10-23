
require("dotenv").config();

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const { randomInt } = require("crypto");

const app = express();
const server = http.createServer(app);

const allowedOrigins = (process.env.FRONTEND_URL || "*")
  .split(",")
  .map((origin) => origin.trim());

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

const rooms = new Map();

function createPin() {
  let pin;

  do {
    pin = String(randomInt(100000, 1000000));
  } while (rooms.has(pin));

  return pin;
}

function publicPlayers(room) {
  return [...room.players.values()].map((player) => ({
    id: player.id,
    nickname: player.nickname,
    score: player.score,
  }));
}

function emitPlayers(pin, room) {
  io.to(pin).emit("room:players", publicPlayers(room));
}

function getRoom(pin) {
  return rooms.get(String(pin || "").trim());
}

function normalizeQuestions(questions) {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error("Cần ít nhất một câu hỏi.");
  }

  return questions.map((q) => {
    if (
      !q ||
      typeof q.question !== "string" ||
      !q.question.trim() ||
      !Array.isArray(q.options) ||
      q.options.length < 2 ||
      !Number.isInteger(q.correctAnswer) ||
      q.correctAnswer < 0 ||
      q.correctAnswer >= q.options.length
    ) {
      throw new Error(
        "Mỗi câu hỏi cần question, options và correctAnswer hợp lệ."
      );
    }

    return {
      question: q.question.trim(),
      options: q.options.map(String),
      correctAnswer: q.correctAnswer,
    };
  });
}

function sendCurrentQuestion(pin, room) {
  const q = room.questions[room.currentIndex];

  room.answerRevealed = false;
  room.answeredPlayers.clear();

  io.to(pin).emit("question:show", {
    index: room.currentIndex,
    total: room.questions.length,
    question: q.question,
    options: q.options,
  });
}

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  // HOST: tạo phòng
  socket.on("host:create", (data = {}, callback = () => {}) => {
    try {
      const questions = normalizeQuestions(data.questions);
      const pin = createPin();

      const room = {
        pin,
        hostId: socket.id,
        questions,
        currentIndex: -1,
        started: false,
        answerRevealed: false,
        answeredPlayers: new Set(),
        players: new Map(),
      };

      rooms.set(pin, room);
      socket.join(pin);
      socket.data.hostPin = pin;

      callback({ ok: true, pin });
      console.log(`Room ${pin} created by ${socket.id}`);
    } catch (error) {
      callback({ ok: false, message: error.message });
    }
  });

  // PLAYER: tham gia phòng
  socket.on("player:join", (data = {}, callback = () => {}) => {
    const pin = String(data.pin || "").trim();
    const nickname = String(data.nickname || "").trim().slice(0, 24);
    const room = getRoom(pin);

    if (!room) {
      return callback({
        ok: false,
        message: "Không tìm thấy phòng chơi.",
      });
    }

    if (room.started) {
      return callback({
        ok: false,
        message: "Trận đấu đã bắt đầu.",
      });
    }

    if (!nickname) {
      return callback({
        ok: false,
        message: "Vui lòng nhập tên người chơi.",
      });
    }

    const player = {
      id: socket.id,
      nickname,
      score: 0,
    };

    room.players.set(socket.id, player);
    socket.join(pin);
    socket.data.playerPin = pin;

    callback({ ok: true, pin, nickname });
    emitPlayers(pin, room);

    console.log(`${nickname} joined room ${pin}`);
  });

  // HOST: bắt đầu trận đấu
  socket.on("host:start", (data = {}, callback = () => {}) => {
    const pin = String(data.pin || "").trim();
    const room = getRoom(pin);

    if (!room || room.hostId !== socket.id) {
      return callback({
        ok: false,
        message: "Bạn không phải chủ phòng.",
      });
    }

    if (room.started) {
      return callback({
        ok: false,
        message: "Trận đấu đã bắt đầu.",
      });
    }

    room.started = true;
    room.currentIndex = 0;

    io.to(pin).emit("game:started");
    sendCurrentQuestion(pin, room);

    callback({ ok: true });
  });

  // PLAYER: gửi đáp án
  socket.on("player:answer", (data = {}, callback = () => {}) => {
    const pin = String(data.pin || "").trim();
    const room = getRoom(pin);

    if (!room || !room.started) {
      return callback({
        ok: false,
        message: "Phòng chưa bắt đầu hoặc không tồn tại.",
      });
    }

    if (room.answerRevealed) {
      return callback({
        ok: false,
        message: "Câu hỏi đã kết thúc.",
      });
    }

    const player = room.players.get(socket.id);
    const q = room.questions[room.currentIndex];
    const answerIndex = data.answerIndex;

    if (!player || socket.data.playerPin !== pin) {
      return callback({
        ok: false,
        message: "Bạn không ở trong phòng này.",
      });
    }

    if (
      !Number.isInteger(answerIndex) ||
      answerIndex < 0 ||
      answerIndex >= q.options.length
    ) {
      return callback({
        ok: false,
        message: "Đáp án không hợp lệ.",
      });
    }

    if (room.answeredPlayers.has(socket.id)) {
      return callback({
        ok: false,
        message: "Bạn đã trả lời câu này rồi.",
      });
    }

    room.answeredPlayers.add(socket.id);

    const correct = answerIndex === q.correctAnswer;

    if (correct) {
      player.score += 100;
    }

    callback({ ok: true, correct });
    emitPlayers(pin, room);
  });

  // HOST: công bố đáp án
  socket.on(
    "host:reveal-answer",
    (data = {}, callback = () => {}) => {
      const pin = String(data.pin || "").trim();
      const room = getRoom(pin);

      if (!room || room.hostId !== socket.id || !room.started) {
        return callback({
          ok: false,
          message: "Không thể công bố đáp án.",
        });
      }

      const q = room.questions[room.currentIndex];
      room.answerRevealed = true;

      io.to(pin).emit("question:result", {
        correctAnswer: q.correctAnswer,
        players: publicPlayers(room),
      });

      callback({ ok: true });
    }
  );

  // HOST: sang câu tiếp theo
  socket.on(
    "host:next-question",
    (data = {}, callback = () => {}) => {
      const pin = String(data.pin || "").trim();
      const room = getRoom(pin);

      if (!room || room.hostId !== socket.id || !room.started) {
        return callback({
          ok: false,
          message: "Không thể chuyển câu hỏi.",
        });
      }

      if (!room.answerRevealed) {
        return callback({
          ok: false,
          message: "Hãy công bố đáp án trước.",
        });
      }

      if (room.currentIndex + 1 >= room.questions.length) {
        const finalPlayers = publicPlayers(room).sort(
          (a, b) => b.score - a.score
        );

        io.to(pin).emit("game:finished", {
          players: finalPlayers,
        });

        callback({ ok: true, finished: true });
        return;
      }

      room.currentIndex += 1;
      sendCurrentQuestion(pin, room);

      callback({ ok: true });
    }
  );

  // Ngắt kết nối
  socket.on("disconnect", () => {
    const hostPin = socket.data.hostPin;
    const playerPin = socket.data.playerPin;

    if (hostPin) {
      const room = getRoom(hostPin);

      if (room && room.hostId === socket.id) {
        io.to(hostPin).emit("room:closed");
        rooms.delete(hostPin);
        console.log(`Room ${hostPin} closed`);
      }
    }

    if (playerPin) {
      const room = getRoom(playerPin);

      if (room && room.players.has(socket.id)) {
        room.players.delete(socket.id);
        room.answeredPlayers.delete(socket.id);
        emitPlayers(playerPin, room);
      }
    }

    console.log("Socket disconnected:", socket.id);
  });
});

app.get("/", (_req, res) => {
  res.json({
    message: "Quiz Socket Server is running",
    rooms: rooms.size,
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Quiz Socket Server listening on port ${PORT}`);
});
