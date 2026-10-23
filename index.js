
require("dotenv").config();

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const { randomInt } = require("crypto");

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

const rooms = new Map();

// =========================
// TIỆN ÍCH
// =========================

function createPin() {
  let pin;

  do {
    pin = String(randomInt(100000, 1000000));
  } while (rooms.has(pin));

  return pin;
}

function getRoom(pin) {
  return rooms.get(String(pin || "").trim());
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

function normalizeQuestions(questions) {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error("Cần ít nhất một câu hỏi.");
  }

  return questions.map((q, index) => {
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
        `Câu ${index + 1} không hợp lệ. Cần question, options và correctAnswer hợp lệ.`
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

  if (!q) return;

  room.answerRevealed = false;
  room.answeredPlayers.clear();

  io.to(pin).emit("question:show", {
    index: room.currentIndex,
    total: room.questions.length,
    question: q.question,
    options: q.options,
  });

  console.log(
    `📝 Phòng ${pin}: câu ${room.currentIndex + 1}/${room.questions.length}`
  );
}

// Kiểm tra chủ phòng
function isHost(socket, room) {
  return Boolean(room && room.hostId === socket.id);
}

// =========================
// SOCKET.IO
// =========================

io.on("connection", (socket) => {
  console.log("🟢 Socket connected:", socket.id);

  // -------------------------
  // HOST: TẠO PHÒNG
  // Frontend gửi:
  // { questions: [{ question, options, correctAnswer }] }
  // -------------------------
  socket.on("host:create", (data = {}, callback = () => {}) => {
    console.log("📥 HOST CREATE:", {
      socketId: socket.id,
      questionsCount: data.questions?.length || 0,
    });

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

      console.log(`✅ Room ${pin} created by ${socket.id}`);

      callback({
        ok: true,
        pin,
        message: "Tạo phòng thành công.",
      });
    } catch (error) {
      console.error("❌ HOST CREATE ERROR:", error.message);

      callback({
        ok: false,
        message: error.message || "Không thể tạo phòng.",
      });
    }
  });

  // -------------------------
  // PLAYER: THAM GIA PHÒNG
  // Frontend gửi: { pin, nickname }
  // -------------------------
  socket.on("player:join", (data = {}, callback = () => {}) => {
    const pin = String(data.pin || "").trim();
    const nickname = String(data.nickname || "").trim().slice(0, 24);

    console.log("📥 PLAYER JOIN:", {
      socketId: socket.id,
      pin,
      nickname,
      existingRooms: [...rooms.keys()],
    });

    const room = getRoom(pin);

    if (!room) {
      return callback({
        ok: false,
        message: "Không tìm thấy phòng chơi. Hãy kiểm tra PIN hoặc tạo phòng mới.",
      });
    }

    if (room.started) {
      return callback({
        ok: false,
        message: "Trận đấu đã bắt đầu, không thể tham gia.",
      });
    }

    if (!nickname) {
      return callback({
        ok: false,
        message: "Vui lòng nhập tên người chơi.",
      });
    }

    // Không cho cùng socket tham gia nhiều phòng
    const oldPin = socket.data.playerPin;

    if (oldPin && oldPin !== pin) {
      const oldRoom = getRoom(oldPin);

      if (oldRoom) {
        oldRoom.players.delete(socket.id);
        oldRoom.answeredPlayers.delete(socket.id);
        emitPlayers(oldPin, oldRoom);
      }

      socket.leave(oldPin);
    }

    const player = {
      id: socket.id,
      nickname,
      score: room.players.get(socket.id)?.score || 0,
    };

    room.players.set(socket.id, player);

    socket.join(pin);
    socket.data.playerPin = pin;

    emitPlayers(pin, room);

    callback({
      ok: true,
      pin,
      nickname,
      players: publicPlayers(room),
      message: "Tham gia phòng thành công.",
    });

    console.log(`✅ ${nickname} joined room ${pin}`);
  });

  // -------------------------
  // HOST: BẮT ĐẦU TRẬN
  // -------------------------
  socket.on("host:start", (data = {}, callback = () => {}) => {
    const pin = String(data.pin || "").trim();
    const room = getRoom(pin);

    console.log("📥 HOST START:", pin);

    if (!isHost(socket, room)) {
      return callback({
        ok: false,
        message: "Bạn không phải chủ phòng hoặc phòng không tồn tại.",
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

    callback({ ok: true, message: "Trận đấu bắt đầu." });

    console.log(`🚀 Room ${pin} started`);
  });

  // -------------------------
  // PLAYER: TRẢ LỜI
  // -------------------------
  socket.on("player:answer", (data = {}, callback = () => {}) => {
    const pin = String(data.pin || "").trim();
    const room = getRoom(pin);

    if (!room || !room.started) {
      return callback({
        ok: false,
        message: "Phòng chưa bắt đầu hoặc không tồn tại.",
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

    if (!q) {
      return callback({
        ok: false,
        message: "Không tìm thấy câu hỏi hiện tại.",
      });
    }

    if (room.answerRevealed) {
      return callback({
        ok: false,
        message: "Câu hỏi đã kết thúc.",
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

    callback({
      ok: true,
      correct,
      score: player.score,
    });

    emitPlayers(pin, room);

    console.log(
      `📝 ${player.nickname} answered in ${pin}: ${correct ? "correct" : "wrong"}`
    );
  });

  // -------------------------
  // HOST: CÔNG BỐ ĐÁP ÁN
  // -------------------------
  socket.on(
    "host:reveal-answer",
    (data = {}, callback = () => {}) => {
      const pin = String(data.pin || "").trim();
      const room = getRoom(pin);

      if (!isHost(socket, room) || !room.started) {
        return callback({
          ok: false,
          message: "Không thể công bố đáp án.",
        });
      }

      const q = room.questions[room.currentIndex];

      if (!q) {
        return callback({
          ok: false,
          message: "Không tìm thấy câu hỏi hiện tại.",
        });
      }

      if (room.answerRevealed) {
        return callback({
          ok: false,
          message: "Đáp án đã được công bố.",
        });
      }

      room.answerRevealed = true;

      io.to(pin).emit("question:result", {
        correctAnswer: q.correctAnswer,
        players: publicPlayers(room),
      });

      callback({ ok: true });

      console.log(`📢 Room ${pin}: answer revealed`);
    }
  );

  // -------------------------
  // HOST: CÂU TIẾP THEO
  // -------------------------
  socket.on(
    "host:next-question",
    (data = {}, callback = () => {}) => {
      const pin = String(data.pin || "").trim();
      const room = getRoom(pin);

      if (!isHost(socket, room) || !room.started) {
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
        const leaderboard = publicPlayers(room).sort(
          (a, b) => b.score - a.score
        );

        io.to(pin).emit("game:finished", {
          players: leaderboard,
          leaderboard,
        });

        callback({
          ok: true,
          finished: true,
          leaderboard,
        });

        console.log(`🏁 Room ${pin} finished`);
        return;
      }

      room.currentIndex += 1;
      sendCurrentQuestion(pin, room);

      callback({ ok: true });
    }
  );

  // -------------------------
  // HOST: ĐÓNG PHÒNG THỦ CÔNG
  // -------------------------
  socket.on("host:close", (data = {}, callback = () => {}) => {
    const pin = String(data.pin || "").trim();
    const room = getRoom(pin);

    if (!isHost(socket, room)) {
      return callback({
        ok: false,
        message: "Bạn không phải chủ phòng.",
      });
    }

    io.to(pin).emit("room:closed", {
      message: "Chủ phòng đã đóng phòng chơi.",
    });

    rooms.delete(pin);

    for (const client of io.sockets.sockets.values()) {
      if (client.data.playerPin === pin) {
        client.data.playerPin = null;
        client.leave(pin);
      }
    }

    socket.data.hostPin = null;
    socket.leave(pin);

    callback({ ok: true, message: "Đã đóng phòng." });

    console.log(`🔒 Room ${pin} closed by host`);
  });

  // -------------------------
  // NGẮT KẾT NỐI
  // -------------------------
  socket.on("disconnect", (reason) => {
    const hostPin = socket.data.hostPin;
    const playerPin = socket.data.playerPin;

    console.log("🔴 Socket disconnected:", socket.id, reason);

    if (hostPin) {
      const room = getRoom(hostPin);

      if (room && room.hostId === socket.id) {
        io.to(hostPin).emit("room:closed", {
          message: "Chủ phòng đã ngắt kết nối.",
        });

        rooms.delete(hostPin);

        console.log(`🔒 Room ${hostPin} closed because host disconnected`);
      }
    }

    if (playerPin) {
      const room = getRoom(playerPin);

      if (room && room.players.has(socket.id)) {
        room.players.delete(socket.id);
        room.answeredPlayers.delete(socket.id);
        emitPlayers(playerPin, room);

        console.log(`👋 Player left room ${playerPin}: ${socket.id}`);
      }
    }
  });
});

// =========================
// HTTP ROUTES
// =========================

app.get("/", (_req, res) => {
  res.json({
    message: "Quiz Socket Server is running",
    rooms: rooms.size,
    roomPins: [...rooms.keys()],
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "quiz-socket-server",
    rooms: rooms.size,
    timestamp: new Date().toISOString(),
  });
});

// =========================
// START SERVER
// =========================

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Quiz Socket Server listening on port ${PORT}`);
});
