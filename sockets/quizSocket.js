
const crypto = require("crypto");
const quizService = require("../services/quizService");

module.exports = function registerQuizSocket(io) {
  const rooms = new Map();

  const DEFAULT_TIME_LIMIT = 20;
  const DEFAULT_POINTS = 1000;
  const MAX_QUESTIONS = 10;

  // =========================
  // ROOM HELPERS
  // =========================

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
    return [...room.players.values()]
      .map((player) => ({
        id: player.id,
        nickname: player.nickname,
        score: player.score,
      }))
      .sort((a, b) => b.score - a.score);
  }

  function emitPlayers(pin, room) {
    io.to(pin).emit("room:players", {
      players: publicPlayers(room),
    });
  }

  function clearQuestionTimer(room) {
    if (room.timer) {
      clearTimeout(room.timer);
      room.timer = null;
    }
  }

  function getRemainingSeconds(room) {
    if (!room.questionEndsAt || room.answerRevealed) {
      return 0;
    }

    return Math.max(
      0,
      Math.ceil((room.questionEndsAt - Date.now()) / 1000)
    );
  }

  // =========================
  // NORMALIZE QUESTIONS
  // =========================

  function normalizeQuestions(sourceQuestions) {
    if (!Array.isArray(sourceQuestions) || sourceQuestions.length === 0) {
      throw new Error("Quiz cần có ít nhất một câu hỏi.");
    }

    // Một trận chỉ chạy tối đa 10 câu.
    return sourceQuestions.slice(0, MAX_QUESTIONS).map((q, index) => {
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

      const rawCorrect = q.correct_answer ?? q.correctAnswer;

      let correctAnswer;

      if (
        typeof rawCorrect === "string" &&
        /^[ABCD]$/i.test(rawCorrect.trim())
      ) {
        correctAnswer =
          rawCorrect.trim().toUpperCase().charCodeAt(0) - 65;
      } else {
        correctAnswer = Number(rawCorrect);
      }

      if (
        !Number.isInteger(correctAnswer) ||
        correctAnswer < 0 ||
        correctAnswer > 3
      ) {
        throw new Error(
          `Đáp án đúng của câu ${index + 1} không hợp lệ.`
        );
      }

      const rawTimeLimit = Number(q.time_limit);
      const rawPoints = Number(q.points);

      const timeLimit =
        Number.isFinite(rawTimeLimit) && rawTimeLimit > 0
          ? Math.min(Math.floor(rawTimeLimit), 300)
          : DEFAULT_TIME_LIMIT;

      const points =
        Number.isFinite(rawPoints) && rawPoints > 0
          ? Math.floor(rawPoints)
          : DEFAULT_POINTS;

      return {
        id: q.id ?? index + 1,
        question_text: questionText,
        answers: normalizedAnswers,
        correct_answer: correctAnswer,
        time_limit: timeLimit,
        points,
      };
    });
  }

  // =========================
  // ANSWER STATISTICS
  // =========================

  function buildQuestionStats(room) {
    const question = room.currentQuestion;
    const totalPlayers = room.players.size;

    const answerCounts = [0, 0, 0, 0];

    let correctCount = 0;
    let wrongCount = 0;

    for (const answer of room.answers.values()) {
      if (
        Number.isInteger(answer.answerIndex) &&
        answer.answerIndex >= 0 &&
        answer.answerIndex <= 3
      ) {
        answerCounts[answer.answerIndex] += 1;
      }

      if (answer.correct) {
        correctCount += 1;
      } else {
        wrongCount += 1;
      }
    }

    const totalAnswered = room.answers.size;
    const unansweredCount = Math.max(
      0,
      totalPlayers - totalAnswered
    );

    return {
      correct_answer: question.correct_answer,
      correctAnswer: question.correct_answer,

      correctCount,
      wrongCount,
      unansweredCount,
      totalAnswered,
      totalPlayers,

      // Giữ mảng số nguyên để frontend có thể dùng trực tiếp.
      answerCounts,

      // Dạng object để frontend hiển thị nhãn và số lượt chọn.
      answerDistribution: answerCounts.map((count, index) => ({
        answerIndex: index,
        label: ["A", "B", "C", "D"][index],
        count,
        isCorrect: index === question.correct_answer,
      })),

      leaderboard: publicPlayers(room),
      players: publicPlayers(room),
    };
  }

  // =========================
  // REVEAL QUESTION RESULT
  // =========================

  function revealQuestion(pin, room, reason = "host") {
    if (!room || room.answerRevealed || !room.currentQuestion) {
      return false;
    }

    clearQuestionTimer(room);

    room.answerRevealed = true;
    room.questionEndsAt = null;

    const stats = buildQuestionStats(room);

    io.to(pin).emit("question:result", {
      ...stats,
      reason,
      index: room.currentIndex + 1,
      total: room.questions.length,
    });

    // Giữ event answer:count tương thích với frontend hiện tại.
    io.to(pin).emit("answer:count", {
      count: stats.totalAnswered,
      totalPlayers: stats.totalPlayers,
    });

    console.log("QUESTION RESULT:", {
      pin,
      question: room.currentIndex + 1,
      reason,
      correct: stats.correctCount,
      wrong: stats.wrongCount,
      unanswered: stats.unansweredCount,
    });

    return true;
  }

  // =========================
  // QUESTION TIMER
  // =========================

  function startQuestionTimer(pin, room) {
    clearQuestionTimer(room);

    const timeLimit = room.currentQuestion.time_limit;

    room.questionEndsAt = Date.now() + timeLimit * 1000;

    // Gửi thời gian bắt đầu để frontend đồng bộ bộ đếm.
    io.to(pin).emit("question:timer", {
      pin,
      index: room.currentIndex + 1,
      timeLimit,
      endsAt: room.questionEndsAt,
      remainingSeconds: timeLimit,
    });

    room.timer = setTimeout(() => {
      // Kiểm tra lại phòng và câu hỏi nhằm tránh timer cũ
      // kết thúc nhầm câu mới.
      const currentRoom = getRoom(pin);

      if (
        currentRoom !== room ||
        !room.started ||
        room.answerRevealed ||
        !room.currentQuestion
      ) {
        return;
      }

      revealQuestion(pin, room, "timeout");
    }, timeLimit * 1000);
  }

  // =========================
  // SEND NEXT QUESTION
  // =========================

  function sendNextQuestion(pin, room) {
    clearQuestionTimer(room);

    const nextIndex = room.currentIndex + 1;

    if (nextIndex >= room.questions.length) {
      room.started = false;
      room.finished = true;
      room.currentQuestion = null;
      room.questionEndsAt = null;

      const leaderboard = publicPlayers(room);

      io.to(pin).emit("game:finished", {
        leaderboard,
        players: leaderboard,
        totalQuestions: room.questions.length,
      });

      console.log("GAME FINISHED:", pin);

      // Giữ phòng sau trận để host/người chơi nhận được event.
      // Phòng sẽ được xóa khi host đóng phòng hoặc host mất kết nối.
      return { finished: true };
    }

    room.currentIndex = nextIndex;
    room.currentQuestion = room.questions[nextIndex];
    room.answerRevealed = false;
    room.answeredPlayers.clear();
    room.answers.clear();

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
      points: q.points,
    });

    startQuestionTimer(pin, room);

    console.log(
      `QUESTION SENT: ${pin} - ${nextIndex + 1}/${room.questions.length}, ${q.time_limit}s`
    );

    return { finished: false };
  }

  // =========================
  // SOCKET CONNECTION
  // =========================

  io.on("connection", (socket) => {
    console.log("SOCKET CONNECTED:", socket.id);

    // =========================
    // HOST: CREATE ROOM
    // =========================

    socket.on("host:create", async (data = {}, callback) => {
      const ack =
        typeof callback === "function" ? callback : () => {};

      try {
        let sourceQuestions = data.questions;
        const quizId = data.quizId || null;
        let title = data.title || "Quiz Multiplayer";

        if (quizId) {
          if (!socket.data.userId) {
            return ack({
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
            return ack({
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
          finished: false,
          answerRevealed: false,

          answeredPlayers: new Set(),
          answers: new Map(),

          timer: null,
          questionEndsAt: null,
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

        return ack({
          ok: true,
          pin,
          quizId,
          title,
          questionCount: questions.length,
        });
      } catch (error) {
        console.error("HOST CREATE ERROR:", error);

        return ack({
          ok: false,
          message: error.message || "Không thể tạo phòng.",
        });
      }
    });

    // =========================
    // PLAYER: JOIN ROOM
    // =========================

    socket.on("player:join", (data = {}, callback) => {
      const ack =
        typeof callback === "function" ? callback : () => {};

      const pin = String(data.pin || "").trim();
      const nickname = String(data.nickname || "")
        .trim()
        .slice(0, 24);

      const room = getRoom(pin);

      if (!room) {
        return ack({
          ok: false,
          message:
            "Không tìm thấy phòng chơi. Hãy kiểm tra PIN hoặc tạo phòng mới.",
        });
      }

      if (room.started || room.finished) {
        return ack({
          ok: false,
          message: "Trận đấu đã bắt đầu hoặc đã kết thúc.",
        });
      }

      if (!nickname) {
        return ack({
          ok: false,
          message: "Vui lòng nhập nickname.",
        });
      }

      const oldPin = socket.data.playerPin;

      if (oldPin && oldPin !== pin) {
        const oldRoom = getRoom(oldPin);

        if (oldRoom) {
          oldRoom.players.delete(socket.id);
          oldRoom.answeredPlayers.delete(socket.id);
          oldRoom.answers.delete(socket.id);
          emitPlayers(oldPin, oldRoom);
        }

        socket.leave(oldPin);
      }

      const existingPlayer = room.players.get(socket.id);

      if (existingPlayer) {
        return ack({
          ok: true,
          pin,
          nickname: existingPlayer.nickname,
          players: publicPlayers(room),
        });
      }

      room.players.set(socket.id, {
        id: socket.id,
        nickname,
        score: 0,
      });

      socket.join(pin);
      socket.data.playerPin = pin;

      emitPlayers(pin, room);

      return ack({
        ok: true,
        pin,
        nickname,
        players: publicPlayers(room),
      });
    });

    // =========================
    // HOST: START GAME
    // =========================

    socket.on("host:start", (data = {}, callback) => {
      const ack =
        typeof callback === "function" ? callback : () => {};

      const room = getRoom(data.pin);

      if (!isHost(socket, room)) {
        return ack({
          ok: false,
          message: "Bạn không phải chủ phòng.",
        });
      }

      if (room.started || room.finished) {
        return ack({
          ok: false,
          message: "Trận đấu đã bắt đầu hoặc đã kết thúc.",
        });
      }

      if (room.players.size === 0) {
        return ack({
          ok: false,
          message: "Cần ít nhất một người chơi.",
        });
      }

      room.started = true;
      room.finished = false;

      io.to(room.pin).emit("game:started", {
        totalQuestions: room.questions.length,
      });

      const result = sendNextQuestion(room.pin, room);

      return ack({ ok: true, ...result });
    });

    // =========================
    // PLAYER: SUBMIT ANSWER
    // =========================

    socket.on("player:answer", (data = {}, callback) => {
      const ack =
        typeof callback === "function" ? callback : () => {};

      const pin = String(data.pin || "").trim();
      const room = getRoom(pin);
      const player = room?.players.get(socket.id);
      const q = room?.currentQuestion;
      const answerIndex = data.answerIndex;

      if (
        !room ||
        !room.started ||
        room.finished ||
        !player ||
        socket.data.playerPin !== pin ||
        !q
      ) {
        return ack({
          ok: false,
          message: "Không thể gửi đáp án.",
        });
      }

      if (room.answerRevealed) {
        return ack({
          ok: false,
          message: "Câu hỏi đã kết thúc.",
        });
      }

      // Phòng trường hợp event đến ngay sau thời điểm hết giờ
      // nhưng callback timer chưa kịp chạy.
      if (
        !room.questionEndsAt ||
        Date.now() >= room.questionEndsAt
      ) {
        revealQuestion(pin, room, "timeout");

        return ack({
          ok: false,
          message: "Đã hết thời gian trả lời.",
        });
      }

      if (
        !Number.isInteger(answerIndex) ||
        answerIndex < 0 ||
        answerIndex > 3
      ) {
        return ack({
          ok: false,
          message: "Đáp án không hợp lệ.",
        });
      }

      if (room.answeredPlayers.has(socket.id)) {
        return ack({
          ok: false,
          message: "Bạn đã trả lời câu này rồi.",
        });
      }

      room.answeredPlayers.add(socket.id);

      const correct = answerIndex === q.correct_answer;

      // Lưu câu trả lời để thống kê sau này.
      room.answers.set(socket.id, {
        playerId: socket.id,
        answerIndex,
        correct,
        answeredAt: Date.now(),
      });

      // Giữ cách tính điểm hiện tại để tương thích.
      if (correct) {
        player.score += q.points;
      }

      ack({
        ok: true,
        correct,
        score: player.score,
        remainingSeconds: getRemainingSeconds(room),
      });

      emitPlayers(pin, room);

      io.to(room.hostSocketId).emit("host:answer-received", {
        playerId: socket.id,
        nickname: player.nickname,
        correct,
        answerIndex,
      });

      io.to(pin).emit("answer:count", {
        count: room.answeredPlayers.size,
        totalPlayers: room.players.size,
      });

      // Nếu tất cả người chơi đã trả lời, tự động hiện kết quả.
      if (room.answeredPlayers.size >= room.players.size) {
        revealQuestion(pin, room, "all-answered");
      }
    });

    // =========================
    // HOST: REVEAL ANSWER
    // =========================

    socket.on("host:reveal-answer", (data = {}, callback) => {
      const ack =
        typeof callback === "function" ? callback : () => {};

      const room = getRoom(data.pin);

      if (
        !isHost(socket, room) ||
        !room.started ||
        !room.currentQuestion
      ) {
        return ack({
          ok: false,
          message: "Không thể công bố đáp án.",
        });
      }

      if (room.answerRevealed) {
        return ack({
          ok: false,
          message: "Đáp án đã được công bố.",
        });
      }

      const revealed = revealQuestion(room.pin, room, "host");

      return ack({
        ok: revealed,
        message: revealed
          ? "Đã công bố kết quả."
          : "Không thể công bố kết quả.",
      });
    });

    // =========================
    // HOST: NEXT QUESTION
    // =========================

    socket.on("host:next-question", (data = {}, callback) => {
      const ack =
        typeof callback === "function" ? callback : () => {};

      const room = getRoom(data.pin);

      if (!isHost(socket, room) || !room.started) {
        return ack({
          ok: false,
          message: "Không thể chuyển câu hỏi.",
        });
      }

      if (!room.answerRevealed) {
        return ack({
          ok: false,
          message: "Hãy chờ hết giờ hoặc công bố đáp án trước.",
        });
      }

      const result = sendNextQuestion(room.pin, room);

      return ack({ ok: true, ...result });
    });

    // =========================
    // HOST: CLOSE ROOM
    // =========================

    socket.on("host:close", (data = {}, callback) => {
      const ack =
        typeof callback === "function" ? callback : () => {};

      const room = getRoom(data.pin);

      if (!isHost(socket, room)) {
        return ack({
          ok: false,
          message: "Bạn không phải chủ phòng.",
        });
      }

      clearQuestionTimer(room);

      io.to(room.pin).emit("room:closed", {
        message: "Chủ phòng đã đóng phòng.",
      });

      rooms.delete(room.pin);

      socket.data.hostPin = null;

      return ack({ ok: true });
    });

    // =========================
    // DISCONNECT
    // =========================

    socket.on("disconnect", (reason) => {
      console.log("SOCKET DISCONNECTED:", socket.id, reason);

      const hostPin = socket.data.hostPin;
      const playerPin = socket.data.playerPin;

      if (hostPin) {
        const hostRoom = getRoom(hostPin);

        if (
          hostRoom &&
          hostRoom.hostSocketId === socket.id
        ) {
          clearQuestionTimer(hostRoom);

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
          playerRoom.answers.delete(socket.id);

          emitPlayers(playerPin, playerRoom);

          // Nếu người chơi rời phòng khiến tất cả người còn lại
          // đã trả lời, kết thúc câu hỏi.
          if (
            playerRoom.started &&
            !playerRoom.answerRevealed &&
            playerRoom.players.size > 0 &&
            playerRoom.answeredPlayers.size >= playerRoom.players.size
          ) {
            revealQuestion(playerPin, playerRoom, "all-answered");
          }
        }
      }
    });
  });

  return {
    getRoomStatus() {
      return {
        count: rooms.size,
        pins: [...rooms.keys()],
      };
    },
  };
};
