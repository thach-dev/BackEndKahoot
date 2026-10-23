
const crypto = require("crypto");
const quizService = require("../services/quizService");

module.exports = function registerQuizSocket(io) {
  const rooms = new Map();

  function createPin() {
    let pin;

    do {
      pin = String(crypto.randomInt(100000, 1000000));
    } while (rooms.has(pin));

    return pin;
  }

  function getRoom(pin) {
    return rooms.get(String(pin || "").trim());
  }

  function isHost(socket, room) {
    return Boolean(room && room.hostSocketId === socket.id);
  }

  function publicPlayers(room) {
    return [...room.players.values()].sort(
      (a, b) => b.score - a.score
    );
  }

  function emitPlayers(pin, room) {
    io.to(pin).emit("room:players", {
      players: publicPlayers(room),
    });
  }

  function normalizeQuestions(questions) {
    if (!Array.isArray(questions) || questions.length === 0) {
      throw new Error("Quiz cần có ít nhất một câu hỏi.");
    }

    return questions.map((q, index) => {
      const questionText = String(
        q.question_text ?? q.question ?? ""
      ).trim();

      const answers = q.answers ?? q.options;

      if (
        !questionText ||
        !Array.isArray(answers) ||
        answers.length !== 4
      ) {
        throw new Error(
          `Câu ${index + 1} cần nội dung và đúng 4 đáp án.`
        );
      }

      const normalizedAnswers = answers.map((answer) =>
        String(answer ?? "").trim()
      );

      if (normalizedAnswers.some((answer) => !answer)) {
        throw new Error(`Câu ${index + 1} có đáp án trống.`);
      }

      const rawCorrect =
        q.correct_answer ?? q.correctAnswer;

      const correctAnswer =
        typeof rawCorrect === "string" &&
        /^[ABCD]$/i.test(rawCorrect.trim())
          ? rawCorrect.trim().toUpperCase().charCodeAt(0) - 65
          : Number(rawCorrect);

      if (
        !Number.isInteger(correctAnswer) ||
        correctAnswer < 0 ||
        correctAnswer > 3
      ) {
        throw new Error(
          `Đáp án đúng của câu ${index + 1} không hợp lệ.`
        );
      }

      return {
        id: q.id ?? index + 1,
        question_text: questionText,
        answers: normalizedAnswers,
        correct_answer: correctAnswer,
        time_limit: Number(q.time_limit) || 20,
        points: Number(q.points) || 1000,
      };
    });
  }

  function sendNextQuestion(pin, room) {
    const nextIndex = room.currentIndex + 1;

    if (nextIndex >= room.questions.length) {
      const leaderboard = publicPlayers(room);

      io.to(pin).emit("game:finished", {
        leaderboard,
        players: leaderboard,
      });

      rooms.delete(pin);

      console.log("GAME FINISHED:", pin);

      return { finished: true };
    }

    room.currentIndex = nextIndex;
    room.currentQuestion = room.questions[nextIndex];
    room.answerRevealed = false;
    room.answeredPlayers.clear();

    const q = room.currentQuestion;

    io.to(pin).emit("question:show", {
      index: nextIndex + 1,
      total: room.questions.length,
      id: q.id,
      question_text: q.question_text,
      question: q.question_text,
      answers: q.answers,
      options: q.answers,
      time_limit: q.time_limit,
    });

    console.log(
      `QUESTION SENT: ${pin} - ${nextIndex + 1}/${room.questions.length}`
    );

    return { finished: false };
  }

  io.on("connection", (socket) => {
    console.log("SOCKET CONNECTED:", socket.id);

    // HOST: TẠO PHÒNG
    socket.on(
      "host:create",
      async (data = {}, callback = () => {}) => {
        try {
          let sourceQuestions = data.questions;
          let quizId = data.quizId || null;
          let title = data.title || "Quiz Multiplayer";

          if (quizId) {
            if (!socket.data.userId) {
              return callback({
                ok: false,
                message:
                  "Socket chưa xác thực. Cần cấu hình JWT middleware.",
              });
            }

            const quiz = await quizService.getQuizForHost(
              quizId,
              socket.data.userId
            );

            if (!quiz) {
              return callback({
                ok: false,
                message:
                  "Không tìm thấy Quiz hoặc bạn không có quyền truy cập.",
              });
            }

            sourceQuestions = quiz.questions;
            title = quiz.title || title;
          }

          const questions = normalizeQuestions(sourceQuestions);
          const pin = createPin();

          const room = {
            pin,
            quizId,
            title,
            hostSocketId: socket.id,
            questions,
            players: new Map(),
            currentIndex: -1,
            currentQuestion: null,
            started: false,
            answerRevealed: false,
            answeredPlayers: new Set(),
          };

          rooms.set(pin, room);

          socket.join(pin);
          socket.data.hostPin = pin;

          console.log("ROOM CREATED:", {
            pin,
            quizId,
            title,
            questionCount: questions.length,
            activeRooms: [...rooms.keys()],
          });

          callback({
            ok: true,
            pin,
            quizId,
            title,
            questionCount: questions.length,
          });
        } catch (error) {
          console.error("HOST CREATE ERROR:", error);

          callback({
            ok: false,
            message: error.message || "Không thể tạo phòng.",
          });
        }
      }
    );

    // PLAYER: THAM GIA
    socket.on(
      "player:join",
      (data = {}, callback = () => {}) => {
        const pin = String(data.pin || "").trim();
        const nickname = String(data.nickname || "")
          .trim()
          .slice(0, 24);

        console.log("PLAYER JOIN:", {
          socketId: socket.id,
          pin,
          nickname,
          existingRooms: [...rooms.keys()],
        });

        const room = getRoom(pin);

        if (!room) {
          return callback({
            ok: false,
            message:
              "Không tìm thấy phòng chơi. Hãy kiểm tra PIN hoặc tạo phòng mới.",
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
            message: "Vui lòng nhập nickname.",
          });
        }

        const existingPlayer = room.players.get(socket.id);

        if (existingPlayer) {
          return callback({
            ok: true,
            pin,
            nickname: existingPlayer.nickname,
            players: publicPlayers(room),
          });
        }

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

        room.players.set(socket.id, {
          id: socket.id,
          nickname,
          score: 0,
        });

        socket.join(pin);
        socket.data.playerPin = pin;

        emitPlayers(pin, room);

        callback({
          ok: true,
          pin,
          nickname,
          players: publicPlayers(room),
        });
      }
    );

    // HOST: BẮT ĐẦU
    socket.on(
      "host:start",
      (data = {}, callback = () => {}) => {
        const room = getRoom(data.pin);

        if (!isHost(socket, room)) {
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

        if (room.players.size === 0) {
          return callback({
            ok: false,
            message: "Cần ít nhất một người chơi.",
          });
        }

        room.started = true;

        io.to(room.pin).emit("game:started", {
          totalQuestions: room.questions.length,
        });

        const result = sendNextQuestion(room.pin, room);

        callback({ ok: true, ...result });
      }
    );

    // PLAYER: TRẢ LỜI
    socket.on(
      "player:answer",
      (data = {}, callback = () => {}) => {
        const pin = String(data.pin || "").trim();
        const room = getRoom(pin);
        const player = room?.players.get(socket.id);
        const q = room?.currentQuestion;
        const answerIndex = data.answerIndex;

        if (
          !room ||
          !room.started ||
          !player ||
          socket.data.playerPin !== pin ||
          !q
        ) {
          return callback({
            ok: false,
            message: "Không thể gửi đáp án.",
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
          answerIndex > 3
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

        const correct = answerIndex === q.correct_answer;

        if (correct) {
          player.score += q.points;
        }

        callback({
          ok: true,
          correct,
          score: player.score,
        });

        emitPlayers(pin, room);

        io.to(room.hostSocketId).emit("host:answer-received", {
          playerId: socket.id,
          nickname: player.nickname,
          correct,
        });

        io.to(pin).emit("answer:count", {
          count: room.answeredPlayers.size,
          totalPlayers: room.players.size,
        });
      }
    );

    // HOST: CÔNG BỐ ĐÁP ÁN
    socket.on(
      "host:reveal-answer",
      (data = {}, callback = () => {}) => {
        const room = getRoom(data.pin);

        if (
          !isHost(socket, room) ||
          !room.started ||
          !room.currentQuestion
        ) {
          return callback({
            ok: false,
            message: "Không thể công bố đáp án.",
          });
        }

        if (room.answerRevealed) {
          return callback({
            ok: false,
            message: "Đáp án đã được công bố.",
          });
        }

        room.answerRevealed = true;

        const leaderboard = publicPlayers(room);

        io.to(room.pin).emit("question:result", {
          correct_answer: room.currentQuestion.correct_answer,
          correctAnswer: room.currentQuestion.correct_answer,
          leaderboard,
          players: leaderboard,
        });

        callback({ ok: true });
      }
    );

    // HOST: CÂU TIẾP THEO
    socket.on(
      "host:next-question",
      (data = {}, callback = () => {}) => {
        const room = getRoom(data.pin);

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

        room.currentQuestion = null;

        const result = sendNextQuestion(room.pin, room);

        callback({ ok: true, ...result });
      }
    );

    // HOST: ĐÓNG PHÒNG
    socket.on(
      "host:close",
      (data = {}, callback = () => {}) => {
        const room = getRoom(data.pin);

        if (!isHost(socket, room)) {
          return callback({
            ok: false,
            message: "Bạn không phải chủ phòng.",
          });
        }

        io.to(room.pin).emit("room:closed", {
          message: "Chủ phòng đã đóng phòng.",
        });

        rooms.delete(room.pin);

        socket.data.hostPin = null;

        callback({ ok: true });
      }
    );

    // DISCONNECT
    socket.on("disconnect", (reason) => {
      console.log("SOCKET DISCONNECTED:", socket.id, reason);

      const hostPin = socket.data.hostPin;
      const playerPin = socket.data.playerPin;

      if (hostPin) {
        const hostRoom = getRoom(hostPin);

        if (hostRoom && hostRoom.hostSocketId === socket.id) {
          io.to(hostPin).emit("room:closed", {
            message: "Chủ phòng đã ngắt kết nối.",
          });

          rooms.delete(hostPin);
        }
      }

      if (playerPin) {
        const playerRoom = getRoom(playerPin);

        if (playerRoom) {
          playerRoom.players.delete(socket.id);
          playerRoom.answeredPlayers.delete(socket.id);
          emitPlayers(playerPin, playerRoom);
        }
      }
    });
  });

  // Route kiểm tra trạng thái phòng.
  // Route được gắn vào Express từ index.js thông qua hàm này.
  app.get("/rooms-status", (_req, res) => {
    res.json({
      count: rooms.size,
      pins: [...rooms.keys()],
    });
  });
};