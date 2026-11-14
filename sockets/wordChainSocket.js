
const crypto = require("crypto");

const rooms = new Map();

const MAX_PLAYERS = 20;
const POINTS_PER_CORRECT = 10;
const GAME_TIME = 180;

// Tên sự kiện riêng của game Nối Từ
const EVENTS = {
    HOST_CREATE: "wordchain:host:create",
    PLAYER_JOIN: "wordchain:player:join",
    HOST_START: "wordchain:host:start",
    PLAYER_MATCH: "wordchain:player:match",
    PLAYER_FINISH: "wordchain:player:finish",
    PLAYER_LEAVE: "wordchain:player:leave",
    HOST_CLOSE: "wordchain:host:close",

    ROOM_PLAYERS: "wordchain:room:players",
    GAME_STARTED: "wordchain:game:started",
    GAME_FINISHED: "wordchain:game:finished",
    GAME_ERROR: "wordchain:game:error",
    MATCH_RESULT: "wordchain:match:result",
    ROOM_CLOSED: "wordchain:room:closed",
    PLAYER_LEFT: "wordchain:player:left",
};

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
            crypto.randomInt(100000, 1000000)
        );
    } while (rooms.has(pin));

    return pin;
};

// Tách phòng Nối Từ khỏi phòng Quiz
const getSocketRoom = (pin) => `wordchain:${pin}`;

const getPlayerId = (socket) => {
    return String(socket.data.userId || socket.id);
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

const getPublicPlayers = (room) => {
    return [...room.players.values()]
        .map((player) => ({
            id: player.id,
            nickname: player.nickname,
            isHost: player.id === room.hostId,
            score: player.score,
            correctCount: player.correctCount,
            wrongCount: player.wrongCount,
            answeredCount: player.answeredQuestionIds.size,
            totalQuestions: room.questions.length,
            finished: player.finished,
        }))
        .sort((a, b) => b.score - a.score);
};

const emitPlayers = (io, room) => {
    io.to(getSocketRoom(room.pin)).emit(
        EVENTS.ROOM_PLAYERS,
        getPublicPlayers(room)
    );
};

const clearGameTimer = (room) => {
    if (room?.gameTimer) {
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
    if (!room || !room.started) return;

    clearGameTimer(room);

    room.started = false;
    room.finished = true;

    io.to(getSocketRoom(room.pin)).emit(
        EVENTS.GAME_FINISHED,
        {
            reason,
            leaderboard: getLeaderboard(room),
            players: getPublicPlayers(room),
        }
    );
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

        // Không gửi đáp án đúng xuống client.
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

function leaveRoom(io, socket, userId) {
    const pin = socket.data.wordChainRoom;

    if (!pin) return;

    const room = rooms.get(pin);

    if (!room) {
        socket.leave(getSocketRoom(pin));
        delete socket.data.wordChainRoom;
        return;
    }

    // Chủ phòng rời phòng
    if (room.hostId === userId) {
        clearGameTimer(room);

        io.to(getSocketRoom(pin)).emit(
            EVENTS.ROOM_CLOSED,
            {
                message: "Chủ phòng đã rời phòng.",
            }
        );

        rooms.delete(pin);

        socket.leave(getSocketRoom(pin));
        delete socket.data.wordChainRoom;

        return;
    }

    const player = room.players.get(userId);

    if (player) {
        room.players.delete(userId);

        io.to(getSocketRoom(pin)).emit(
            EVENTS.PLAYER_LEFT,
            {
                playerId: userId,
                nickname: player.nickname,
            }
        );

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

    socket.leave(getSocketRoom(pin));
    delete socket.data.wordChainRoom;
}

const registerWordChainSocket = (io) => {
    io.on("connection", (socket) => {
        const userId = getPlayerId(socket);

        console.log(
            "WORD CHAIN SOCKET CONNECTED:",
            socket.id,
            userId
        );

        // ====================================
        // HOST CREATE ROOM
        // ====================================

        socket.on(EVENTS.HOST_CREATE, (payload = {}, callback) => {
            const ack =
                typeof callback === "function"
                    ? callback
                    : () => {};

            try {
                const {
                    wordSetId,
                    wordSetTitle,
                    gameData,
                    questions,
                    options,
                    hostNickname,
                } = payload;

                const sourceQuestions =
                    gameData?.questions || questions;

                const sourceOptions =
                    gameData?.options || options;

                if (
                    !wordSetId ||
                    !Array.isArray(sourceQuestions) ||
                    !Array.isArray(sourceOptions)
                ) {
                    return ack({
                        success: false,
                        message: "Dữ liệu bộ ghép đôi không hợp lệ.",
                    });
                }

                if (
                    sourceQuestions.length < 1 ||
                    sourceQuestions.length > 1000
                ) {
                    return ack({
                        success: false,
                        message: "Bộ câu hỏi phải có từ 1 đến 1000 câu.",
                    });
                }

                if (
                    sourceOptions.length < 1 ||
                    sourceOptions.length > 1000
                ) {
                    return ack({
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
                        item.correct_option_key ?? "0"
                    ).trim();

                    if (!id || !leftText) continue;

                    if (questionIds.has(id)) {
                        return ack({
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
                        return ack({
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
                    return ack({
                        success: false,
                        message: "Không có đủ câu hỏi hoặc đáp án.",
                    });
                }

                for (const question of normalizedQuestions) {
                    if (
                        question.correct_option_key !== "0" &&
                        !optionKeys.has(question.correct_option_key)
                    ) {
                        return ack({
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
                    wordSetTitle: wordSetTitle || "Bộ ghép đôi",

                    questions: normalizedQuestions,
                    options: normalizedOptions,

                    players: new Map(),

                    started: false,
                    finished: false,
                    gameTimer: null,
                };

                room.players.set(userId, {
                    id: userId,
                    nickname: String(
                        hostNickname || "Chủ phòng"
                    ).trim(),
                    score: 0,
                    correctCount: 0,
                    wrongCount: 0,
                    answeredQuestionIds: new Set(),
                    finished: false,
                });

                rooms.set(pin, room);

                socket.join(getSocketRoom(pin));
                socket.data.wordChainRoom = pin;

                emitPlayers(io, room);

                console.log("WORD CHAIN ROOM CREATED:", pin);

                return ack({
                    success: true,
                    pin,
                    wordSetTitle: room.wordSetTitle,
                    players: getPublicPlayers(room),
                });
            } catch (error) {
                console.error("WORD CHAIN HOST CREATE ERROR:", error);

                return ack({
                    success: false,
                    message: error.message || "Không thể tạo phòng.",
                });
            }
        });

        // ====================================
        // PLAYER JOIN
        // ====================================

        socket.on(EVENTS.PLAYER_JOIN, (payload = {}, callback) => {
            const ack =
                typeof callback === "function"
                    ? callback
                    : () => {};

            try {
                const pin = String(payload.pin || "").trim();
                const nickname = String(
                    payload.nickname || ""
                ).trim();

                const room = rooms.get(pin);

                if (!room) {
                    return ack({
                        success: false,
                        message: "Phòng không tồn tại.",
                    });
                }

                if (room.started || room.finished) {
                    return ack({
                        success: false,
                        message: "Trận đấu đã bắt đầu hoặc kết thúc.",
                    });
                }

                if (!nickname || nickname.length > 24) {
                    return ack({
                        success: false,
                        message: "Tên người chơi phải từ 1 đến 24 ký tự.",
                    });
                }

                if (room.players.has(userId)) {
                    return ack({
                        success: false,
                        message: "Bạn đã ở trong phòng.",
                    });
                }

                if (room.players.size >= MAX_PLAYERS) {
                    return ack({
                        success: false,
                        message: "Phòng đã đủ người.",
                    });
                }

                const oldPin = socket.data.wordChainRoom;

                if (oldPin && oldPin !== pin) {
                    leaveRoom(io, socket, userId);
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

                socket.join(getSocketRoom(pin));
                socket.data.wordChainRoom = pin;

                emitPlayers(io, room);

                return ack({
                    success: true,
                    pin,
                    players: getPublicPlayers(room),
                });
            } catch (error) {
                console.error("WORD CHAIN PLAYER JOIN ERROR:", error);

                return ack({
                    success: false,
                    message: "Không thể tham gia phòng.",
                });
            }
        });

        // ====================================
        // HOST START GAME
        // ====================================

        socket.on(EVENTS.HOST_START, (payload = {}, callback) => {
            const ack =
                typeof callback === "function"
                    ? callback
                    : () => {};

            const pin = String(
                payload.pin || socket.data.wordChainRoom || ""
            ).trim();

            const room = rooms.get(pin);

            if (!room || room.hostId !== userId) {
                return ack({
                    success: false,
                    message: "Bạn không phải chủ phòng.",
                });
            }

            if (room.started || room.finished) {
                return ack({
                    success: false,
                    message: "Trận đấu đã bắt đầu hoặc kết thúc.",
                });
            }

            if (room.players.size < 2) {
                return ack({
                    success: false,
                    message: "Cần ít nhất 2 người chơi.",
                });
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

            io.to(getSocketRoom(pin)).emit(
                EVENTS.GAME_STARTED,
                getPlayerGameData(room)
            );

            room.gameTimer = setTimeout(() => {
                finishGame(io, room, "time_up");
            }, GAME_TIME * 1000);

            emitPlayers(io, room);

            return ack({ success: true });
        });

        // ====================================
        // PLAYER MATCH
        // ====================================

        socket.on(EVENTS.PLAYER_MATCH, (payload = {}, callback) => {
            const ack =
                typeof callback === "function"
                    ? callback
                    : () => {};

            try {
                const pin = socket.data.wordChainRoom;
                const room = rooms.get(pin);

                if (!room || !room.started) {
                    return ack({
                        success: false,
                        message: "Trận đấu chưa bắt đầu.",
                    });
                }

                const player = room.players.get(userId);

                if (!player) {
                    return ack({
                        success: false,
                        message: "Bạn không có trong phòng.",
                    });
                }

                if (player.finished) {
                    return ack({
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
                    return ack({
                        success: false,
                        message: "Cặp ghép không hợp lệ.",
                    });
                }

                if (player.answeredQuestionIds.has(questionId)) {
                    return ack({
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
                    answeredCount: player.answeredQuestionIds.size,
                    totalQuestions: room.questions.length,
                    finished: player.finished,
                };

                socket.emit(EVENTS.MATCH_RESULT, result);

                emitPlayers(io, room);

                ack(result);

                checkAllPlayersFinished(io, room);
            } catch (error) {
                console.error("WORD CHAIN PLAYER MATCH ERROR:", error);

                ack({
                    success: false,
                    message: "Không thể kiểm tra cặp ghép.",
                });
            }
        });

        // ====================================
        // PLAYER FINISH
        // ====================================

        socket.on(EVENTS.PLAYER_FINISH, () => {
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

        socket.on(EVENTS.PLAYER_LEAVE, () => {
            leaveRoom(io, socket, userId);
        });

        // ====================================
        // HOST CLOSE ROOM
        // ====================================

        socket.on(EVENTS.HOST_CLOSE, (payload = {}, callback) => {
            const ack =
                typeof callback === "function"
                    ? callback
                    : () => {};

            const pin = String(
                payload.pin || socket.data.wordChainRoom || ""
            ).trim();

            const room = rooms.get(pin);

            if (!room || room.hostId !== userId) {
                return ack({
                    success: false,
                    message: "Bạn không phải chủ phòng.",
                });
            }

            clearGameTimer(room);

            io.to(getSocketRoom(pin)).emit(
                EVENTS.ROOM_CLOSED,
                {
                    message: "Chủ phòng đã đóng phòng.",
                }
            );

            rooms.delete(pin);

            socket.leave(getSocketRoom(pin));
            delete socket.data.wordChainRoom;

            return ack({ success: true });
        });

        // ====================================
        // DISCONNECT
        // ====================================

        socket.on("disconnect", () => {
            leaveRoom(io, socket, userId);
        });
    });

    return {
        getRoomStatus() {
            return {
                totalRooms: rooms.size,
                rooms: [...rooms.values()].map((room) => ({
                    pin: room.pin,
                    wordSetId: room.wordSetId,
                    players: room.players.size,
                    started: room.started,
                    finished: room.finished,
                })),
            };
        },
    };
};

module.exports = registerWordChainSocket;
