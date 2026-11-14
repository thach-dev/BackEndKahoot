
const rooms = new Map();

const MAX_PLAYERS = 20;
const POINTS_PER_CORRECT = 10;
const GAME_TIME = 180;

const normalize = (value) => {
    return String(value || "")
        .normalize("NFC")
        .trim()
        .toLocaleLowerCase("vi-VN")
        .replace(/\s+/g, " ");
};

const createPin = () => {
    let pin;

    do {
        pin = String(
            Math.floor(100000 + Math.random() * 900000)
        );
    } while (rooms.has(pin));

    return pin;
};

const shuffle = (array) => {
    const result = [...array];

    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));

        [result[i], result[j]] = [
            result[j],
            result[i],
        ];
    }

    return result;
};

const getPlayerId = (socket) => {
    return socket.data.userId || socket.id;
};

const getPublicPlayers = (room) => {
    return [...room.players.values()].map((player) => ({
        id: player.id,
        nickname: player.nickname,
        isHost: player.id === room.hostId,
        score: player.score,
        correctCount: player.correctCount,
        answeredCount: player.answeredQuestionIds.size,
        totalQuestions: room.questions.length,
        finished: player.finished,
    }));
};

const emitPlayers = (io, room) => {
    io.to(room.pin).emit(
        "room:players",
        getPublicPlayers(room)
    );
};

const clearGameTimer = (room) => {
    if (room.gameTimer) {
        clearTimeout(room.gameTimer);
        room.gameTimer = null;
    }
};

const getLeaderboard = (room) => {
    return [...room.players.values()]
        .map((player) => ({
            id: player.id,
            nickname: player.nickname,
            score: player.score,
            correctCount: player.correctCount,
            wrongCount: player.wrongCount,
            answeredCount: player.answeredQuestionIds.size,
            totalQuestions: room.questions.length,
        }))
        .sort((a, b) => {
            if (b.score !== a.score) {
                return b.score - a.score;
            }

            return b.correctCount - a.correctCount;
        });
};

const finishGame = (io, room, reason = "completed") => {
    if (!room.started) return;

    clearGameTimer(room);

    room.started = false;
    room.finished = true;

    io.to(room.pin).emit("game:finished", {
        reason,
        leaderboard: getLeaderboard(room),
        players: getPublicPlayers(room),
    });
};

const checkAllPlayersFinished = (io, room) => {
    if (!room.started) return;

    const players = [...room.players.values()];

    if (!players.length) return;

    const allFinished = players.every(
        (player) => player.finished
    );

    if (allFinished) {
        finishGame(io, room, "completed");
    }
};

const getPlayerGameData = (room) => {
    return {
        pin: room.pin,
        wordSetTitle: room.wordSetTitle,

        // Không gửi correct_option_key xuống client.
        questions: room.questions.map((question) => ({
            id: question.id,
            left_text: question.left_text,
        })),

        options: room.options.map((option) => ({
            option_key: option.option_key,
            right_text: option.right_text,
        })),

        totalQuestions: room.questions.length,
        timeLimit: GAME_TIME,
    };
};

const registerWordChainSocket = (io) => {
    io.on("connection", (socket) => {
        const userId = getPlayerId(socket);

        // ====================================
        // HOST CREATE ROOM
        // ====================================

        socket.on("host:create", (payload = {}, callback) => {
            try {
                const {
                    wordSetId,
                    wordSetTitle,
                    gameData,
                    questions,
                    options,
                    hostNickname,
                } = payload;

                // Hỗ trợ cả gameData và dữ liệu truyền trực tiếp.
                const sourceQuestions =
                    gameData?.questions || questions;

                const sourceOptions =
                    gameData?.options || options;

                if (
                    !wordSetId ||
                    !Array.isArray(sourceQuestions) ||
                    !Array.isArray(sourceOptions)
                ) {
                    return callback?.({
                        success: false,
                        message: "Dữ liệu bộ ghép đôi không hợp lệ.",
                    });
                }

                if (
                    sourceQuestions.length < 1 ||
                    sourceQuestions.length > 1000
                ) {
                    return callback?.({
                        success: false,
                        message: "Bộ câu hỏi phải có từ 1 đến 1000 câu.",
                    });
                }

                if (
                    sourceOptions.length < 1 ||
                    sourceOptions.length > 1000
                ) {
                    return callback?.({
                        success: false,
                        message: "Bộ đáp án không hợp lệ.",
                    });
                }

                const normalizedQuestions = [];
                const questionIds = new Set();

                for (const item of sourceQuestions) {
                    const id = String(item.id || "").trim();
                    const leftText = String(
                        item.left_text || ""
                    ).trim();

                    const correctKey = String(
                        item.correct_option_key || "0"
                    ).trim();

                    if (!id || !leftText) continue;

                    if (questionIds.has(id)) {
                        return callback?.({
                            success: false,
                            message: `Câu hỏi bị trùng ID: ${id}`,
                        });
                    }

                    questionIds.add(id);

                    normalizedQuestions.push({
                        id,
                        left_text: leftText,
                        correct_option_key: correctKey,
                    });
                }

                const normalizedOptions = [];
                const optionKeys = new Set();

                for (const item of sourceOptions) {
                    const key = String(
                        item.option_key || ""
                    ).trim();

                    const rightText = String(
                        item.right_text || ""
                    ).trim();

                    if (!key || !rightText) continue;

                    if (optionKeys.has(key)) {
                        return callback?.({
                            success: false,
                            message: `Mã đáp án bị trùng: ${key}`,
                        });
                    }

                    optionKeys.add(key);

                    normalizedOptions.push({
                        option_key: key,
                        right_text: rightText,
                    });
                }

                if (
                    !normalizedQuestions.length ||
                    !normalizedOptions.length
                ) {
                    return callback?.({
                        success: false,
                        message: "Không có đủ câu hỏi hoặc đáp án.",
                    });
                }

                // Kiểm tra đáp án có tồn tại trong cột phải.
                for (const question of normalizedQuestions) {
                    if (
                        question.correct_option_key !== "0" &&
                        !optionKeys.has(question.correct_option_key)
                    ) {
                        return callback?.({
                            success: false,
                            message:
                                `Câu ${question.id} có mã đáp án không tồn tại.`,
                        });
                    }
                }

                const pin = createPin();

                const room = {
                    pin,
                    hostId: userId,
                    wordSetId,
                    wordSetTitle:
                        wordSetTitle || "Bộ ghép đôi",

                    questions: normalizedQuestions,
                    options: normalizedOptions,

                    players: new Map(),

                    started: false,
                    finished: false,
                    gameTimer: null,
                };

                // Chủ phòng cũng tham gia chơi.
                room.players.set(userId, {
                    id: userId,
                    nickname:
                        String(hostNickname || "Chủ phòng").trim(),
                    score: 0,
                    correctCount: 0,
                    wrongCount: 0,
                    answeredQuestionIds: new Set(),
                    finished: false,
                });

                rooms.set(pin, room);

                socket.join(pin);
                socket.data.wordChainRoom = pin;

                emitPlayers(io, room);

                callback?.({
                    success: true,
                    pin,
                    wordSetTitle: room.wordSetTitle,
                    players: getPublicPlayers(room),
                });
            } catch (error) {
                console.error("host:create:", error);

                callback?.({
                    success: false,
                    message: "Không thể tạo phòng.",
                });
            }
        });

        // ====================================
        // PLAYER JOIN
        // ====================================

        socket.on("player:join", (payload = {}, callback) => {
            try {
                const pin = String(
                    payload.pin || ""
                ).trim();

                const nickname = String(
                    payload.nickname || ""
                ).trim();

                const room = rooms.get(pin);

                if (!room) {
                    return callback?.({
                        success: false,
                        message: "Phòng không tồn tại.",
                    });
                }

                if (room.started || room.finished) {
                    return callback?.({
                        success: false,
                        message: "Trận đấu đã bắt đầu hoặc kết thúc.",
                    });
                }

                if (!nickname || nickname.length > 24) {
                    return callback?.({
                        success: false,
                        message: "Tên người chơi phải từ 1 đến 24 ký tự.",
                    });
                }

                if (room.players.has(userId)) {
                    return callback?.({
                        success: false,
                        message: "Bạn đã ở trong phòng.",
                    });
                }

                if (room.players.size >= MAX_PLAYERS) {
                    return callback?.({
                        success: false,
                        message: "Phòng đã đủ người.",
                    });
                }

                room.players.set(userId, {
                    id: userId,
                    nickname,
                    score: 0,
                    correctCount: 0,
                    wrongCount: 0,
                    answeredQuestionIds: new Set(),
                    finished: false,
                });

                socket.join(pin);
                socket.data.wordChainRoom = pin;

                emitPlayers(io, room);

                callback?.({
                    success: true,
                    pin,
                    players: getPublicPlayers(room),
                });
            } catch (error) {
                console.error("player:join:", error);

                callback?.({
                    success: false,
                    message: "Không thể tham gia phòng.",
                });
            }
        });

        // ====================================
        // HOST START GAME
        // ====================================

        socket.on("host:start", () => {
            const pin = socket.data.wordChainRoom;
            const room = rooms.get(pin);

            if (!room || room.hostId !== userId) return;
            if (room.started || room.finished) return;

            if (room.players.size < 2) {
                socket.emit("game:error", {
                    message: "Cần ít nhất 2 người chơi.",
                });
                return;
            }

            room.started = true;

            room.questions = shuffle(room.questions);
            room.options = shuffle(room.options);

            for (const player of room.players.values()) {
                player.score = 0;
                player.correctCount = 0;
                player.wrongCount = 0;
                player.answeredQuestionIds = new Set();
                player.finished = false;
            }

            io.to(pin).emit(
                "game:started",
                getPlayerGameData(room)
            );

            room.gameTimer = setTimeout(() => {
                finishGame(io, room, "time_up");
            }, GAME_TIME * 1000);

            emitPlayers(io, room);
        });

        // ====================================
        // PLAYER MATCH
        // ====================================

        socket.on("player:match", (payload = {}, callback) => {
            try {
                const pin = socket.data.wordChainRoom;
                const room = rooms.get(pin);

                if (!room || !room.started) {
                    return callback?.({
                        success: false,
                        message: "Trận đấu chưa bắt đầu.",
                    });
                }

                const player = room.players.get(userId);

                if (!player) {
                    return callback?.({
                        success: false,
                        message: "Bạn không có trong phòng.",
                    });
                }

                if (player.finished) {
                    return callback?.({
                        success: false,
                        message: "Bạn đã hoàn thành lượt chơi.",
                    });
                }

                const questionId = String(
                    payload.questionId || ""
                ).trim();

                const optionKey = String(
                    payload.optionKey || ""
                ).trim();

                const question = room.questions.find(
                    (item) => item.id === questionId
                );

                const option = room.options.find(
                    (item) => item.option_key === optionKey
                );

                if (!question || !option) {
                    return callback?.({
                        success: false,
                        message: "Cặp ghép không hợp lệ.",
                    });
                }

                if (
                    player.answeredQuestionIds.has(questionId)
                ) {
                    return callback?.({
                        success: false,
                        message: "Câu hỏi này đã được trả lời.",
                    });
                }

                player.answeredQuestionIds.add(questionId);

                const isCorrect =
                    question.correct_option_key !== "0" &&
                    question.correct_option_key === optionKey;

                if (isCorrect) {
                    player.score += POINTS_PER_CORRECT;
                    player.correctCount += 1;
                } else {
                    player.wrongCount += 1;
                }

                if (
                    player.answeredQuestionIds.size >=
                    room.questions.length
                ) {
                    player.finished = true;
                }

                const result = {
                    success: true,
                    questionId,
                    optionKey,
                    isCorrect,
                    points: isCorrect ? POINTS_PER_CORRECT : 0,
                    score: player.score,
                    correctCount: player.correctCount,
                    wrongCount: player.wrongCount,
                    answeredCount:
                        player.answeredQuestionIds.size,
                    totalQuestions: room.questions.length,
                    finished: player.finished,
                };

                // Chỉ gửi kết quả chi tiết cho người trả lời.
                socket.emit("match:result", result);

                // Cập nhật bảng người chơi cho toàn phòng.
                emitPlayers(io, room);

                callback?.(result);

                checkAllPlayersFinished(io, room);
            } catch (error) {
                console.error("player:match:", error);

                callback?.({
                    success: false,
                    message: "Không thể kiểm tra cặp ghép.",
                });
            }
        });

        // ====================================
        // PLAYER FINISH
        // ====================================

        socket.on("player:finish", () => {
            const pin = socket.data.wordChainRoom;
            const room = rooms.get(pin);

            if (!room || !room.started) return;

            const player = room.players.get(userId);

            if (!player) return;

            player.finished = true;

            emitPlayers(io, room);

            checkAllPlayersFinished(io, room);
        });

        // ====================================
        // PLAYER LEAVE
        // ====================================

        socket.on("player:leave", () => {
            leaveRoom(io, socket, userId);
        });

        // ====================================
        // HOST CLOSE ROOM
        // ====================================

        socket.on("host:close", () => {
            const pin = socket.data.wordChainRoom;
            const room = rooms.get(pin);

            if (!room || room.hostId !== userId) return;

            clearGameTimer(room);

            io.to(pin).emit("room:closed", {
                message: "Chủ phòng đã đóng phòng.",
            });

            rooms.delete(pin);

            for (const member of room.players.keys()) {
                // Socket của các người chơi khác sẽ được
                // xử lý khi họ rời hoặc ngắt kết nối.
                if (member === userId) continue;
            }
        });

        // ====================================
        // DISCONNECT
        // ====================================

        socket.on("disconnect", () => {
            leaveRoom(io, socket, userId);
        });
    });

    return {
        getRoomStatus: () => ({
            totalRooms: rooms.size,

            rooms: [...rooms.values()].map((room) => ({
                pin: room.pin,
                wordSetId: room.wordSetId,
                players: room.players.size,
                started: room.started,
                finished: room.finished,
            })),
        }),
    };
};

// ========================================
// LEAVE ROOM
// ========================================

function leaveRoom(io, socket, userId) {
    const pin = socket.data.wordChainRoom;

    if (!pin) return;

    const room = rooms.get(pin);

    if (!room) {
        socket.leave(pin);
        delete socket.data.wordChainRoom;
        return;
    }

    if (room.hostId === userId) {
        clearGameTimer(room);

        io.to(pin).emit("room:closed", {
            message: "Chủ phòng đã rời phòng.",
        });

        rooms.delete(pin);

        socket.leave(pin);
        delete socket.data.wordChainRoom;

        return;
    }

    const player = room.players.get(userId);

    if (player) {
        room.players.delete(userId);

        io.to(pin).emit("player:left", {
            playerId: userId,
            nickname: player.nickname,
        });

        emitPlayers(io, room);

        if (room.started) {
            if (room.players.size === 0) {
                clearGameTimer(room);
                rooms.delete(pin);
            } else {
                checkAllPlayersFinished(io, room);
            }
        }
    }

    socket.leave(pin);
    delete socket.data.wordChainRoom;
}

module.exports = registerWordChainSocket;
