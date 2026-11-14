
const rooms = new Map();

const TURN_TIME = 20;
const MAX_PLAYERS = 20;

const normalize = (word) => {
    return String(word || "")
        .normalize("NFC")
        .trim()
        .toLocaleLowerCase("vi-VN")
        .replace(/\s+/g, " ");
};

const getFirstPart = (word) => {
    const parts = normalize(word).split(" ");
    return parts[0];
};

const getLastPart = (word) => {
    const parts = normalize(word).split(" ");
    return parts[parts.length - 1];
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

const getPublicPlayers = (room) => {
    return [...room.players.values()].map((player) => ({
        id: player.id,
        nickname: player.nickname,
        alive: player.alive,
        isHost: player.id === room.hostId,
    }));
};

const emitPlayers = (io, room) => {
    io.to(room.pin).emit(
        "room:players",
        getPublicPlayers(room)
    );
};

const clearTurnTimer = (room) => {
    if (room.turnTimer) {
        clearTimeout(room.turnTimer);
        room.turnTimer = null;
    }
};

const finishGame = (io, room, winnerId = null) => {
    clearTurnTimer(room);

    room.started = false;

    io.to(room.pin).emit("game:finished", {
        winnerId,
        winner: winnerId
            ? room.players.get(winnerId)?.nickname || null
            : null,
        players: getPublicPlayers(room),
    });
};

const eliminatePlayer = (io, room, playerId, reason) => {
    const player = room.players.get(playerId);

    if (!player || !player.alive) return;

    player.alive = false;

    io.to(room.pin).emit("player:eliminated", {
        playerId,
        nickname: player.nickname,
        reason,
    });

    emitPlayers(io, room);
};

const getNextAliveIndex = (room, currentIndex) => {
    const length = room.turnOrder.length;

    for (let step = 1; step <= length; step++) {
        const index = (currentIndex + step) % length;
        const playerId = room.turnOrder[index];
        const player = room.players.get(playerId);

        if (player?.alive) return index;
    }

    return -1;
};

const startTurn = (io, room) => {
    clearTurnTimer(room);

    const alivePlayers = [...room.players.values()]
        .filter((player) => player.alive);

    if (alivePlayers.length <= 1) {
        finishGame(io, room, alivePlayers[0]?.id || null);
        return;
    }

    const playerId = room.turnOrder[room.turnIndex];
    const player = room.players.get(playerId);

    if (!player || !player.alive) {
        const nextIndex = getNextAliveIndex(
            room,
            room.turnIndex
        );

        if (nextIndex === -1) {
            finishGame(io, room);
            return;
        }

        room.turnIndex = nextIndex;
        return startTurn(io, room);
    }

    room.currentPlayerId = playerId;

    io.to(room.pin).emit("turn:started", {
        playerId,
        currentPlayerId: playerId,
        nickname: player.nickname,
        previousWord: room.previousWord,
        timeLimit: TURN_TIME,
    });

    room.turnTimer = setTimeout(() => {
        eliminatePlayer(
            io,
            room,
            playerId,
            "Hết thời gian trả lời."
        );

        const nextIndex = getNextAliveIndex(
            room,
            room.turnIndex
        );

        if (nextIndex === -1) {
            finishGame(io, room);
            return;
        }

        room.turnIndex = nextIndex;
        startTurn(io, room);
    }, TURN_TIME * 1000);
};

const registerWordChainSocket = (io) => {
    io.on("connection", (socket) => {
        const userId = socket.data.userId;

        // ====================================
        // HOST CREATE ROOM
        // ====================================

        socket.on("host:create", (payload = {}, callback) => {
            try {
                const {
                    wordSetId,
                    wordSetTitle,
                    words,
                } = payload;

                if (!wordSetId || !Array.isArray(words)) {
                    return callback?.({
                        success: false,
                        message: "Dữ liệu bộ từ không hợp lệ.",
                    });
                }

                if (words.length < 2 || words.length > 1000) {
                    return callback?.({
                        success: false,
                        message: "Bộ từ phải có từ 2 đến 1000 từ.",
                    });
                }

                const normalizedWords = [];
                const seen = new Set();

                for (const item of words) {
                    const rawWord = typeof item === "string"
                        ? item
                        : item?.word;

                    const word = String(rawWord || "")
                        .normalize("NFC")
                        .trim()
                        .replace(/\s+/g, " ");

                    const normalized = normalize(word);

                    if (!word || !normalized || seen.has(normalized)) {
                        continue;
                    }

                    seen.add(normalized);

                    normalizedWords.push({
                        word,
                        normalized_word: normalized,
                    });
                }

                if (normalizedWords.length < 2) {
                    return callback?.({
                        success: false,
                        message: "Bộ từ không có đủ từ hợp lệ.",
                    });
                }

                const pin = createPin();

                const room = {
                    pin,
                    hostId: userId,
                    wordSetId,
                    wordSetTitle: wordSetTitle || "Bộ từ",
                    words: normalizedWords,
                    wordMap: new Map(
                        normalizedWords.map((item) => [
                            item.normalized_word,
                            item,
                        ])
                    ),
                    players: new Map(),
                    usedWords: new Set(),
                    turnOrder: [],
                    turnIndex: 0,
                    currentPlayerId: null,
                    previousWord: null,
                    started: false,
                    turnTimer: null,
                };

                rooms.set(pin, room);

                callback?.({
                    success: true,
                    pin,
                    wordSetTitle: room.wordSetTitle,
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
                const pin = String(payload.pin || "").trim();
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

                if (room.started) {
                    return callback?.({
                        success: false,
                        message: "Trận đấu đã bắt đầu.",
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

                const player = {
                    id: userId,
                    nickname,
                    alive: true,
                };

                room.players.set(userId, player);

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
            if (room.started) return;

            if (room.players.size < 2) {
                socket.emit("game:error", {
                    message: "Cần ít nhất 2 người chơi.",
                });
                return;
            }

            room.started = true;
            room.turnOrder = [...room.players.keys()];
            room.turnIndex = 0;

            const firstWord =
                room.words[
                    Math.floor(Math.random() * room.words.length)
                ];

            room.previousWord = firstWord.word;
            room.usedWords.add(firstWord.normalized_word);

            io.to(pin).emit("game:started", {
                firstWord: firstWord.word,
                players: getPublicPlayers(room),
            });

            startTurn(io, room);
        });

        // ====================================
        // SUBMIT WORD
        // ====================================

        socket.on("player:submit-word", (payload = {}) => {
            const pin = socket.data.wordChainRoom;
            const room = rooms.get(pin);

            if (!room || !room.started) return;

            if (room.currentPlayerId !== userId) {
                socket.emit("game:error", {
                    message: "Chưa đến lượt của bạn.",
                });
                return;
            }

            const submitted = String(
                payload.word || ""
            ).trim();

            const normalized = normalize(submitted);

            const validWord = room.wordMap.get(normalized);

            if (!validWord) {
                socket.emit("game:error", {
                    message: "Từ không có trong bộ từ.",
                });
                return;
            }

            if (room.usedWords.has(normalized)) {
                socket.emit("game:error", {
                    message: "Từ này đã được sử dụng.",
                });
                return;
            }

            const required = getLastPart(room.previousWord);
            const firstPart = getFirstPart(validWord.word);

            if (firstPart !== required) {
                socket.emit("game:error", {
                    message: `Từ tiếp theo phải bắt đầu bằng "${required}".`,
                });
                return;
            }

            clearTurnTimer(room);

            room.usedWords.add(normalized);
            room.previousWord = validWord.word;

            io.to(pin).emit("word:accepted", {
                playerId: userId,
                nickname: room.players.get(userId)?.nickname,
                word: validWord.word,
            });

            const nextIndex = getNextAliveIndex(
                room,
                room.turnIndex
            );

            if (nextIndex === -1) {
                finishGame(io, room);
                return;
            }

            room.turnIndex = nextIndex;
            startTurn(io, room);
        });

        // ====================================
        // LEAVE ROOM
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

            clearTurnTimer(room);

            io.to(pin).emit("room:closed", {
                message: "Chủ phòng đã đóng phòng.",
            });

            rooms.delete(pin);
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
        delete socket.data.wordChainRoom;
        return;
    }

    if (room.hostId === userId) {
        clearTurnTimer(room);

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

        const oldIndex = room.turnOrder.indexOf(userId);

        room.turnOrder = room.turnOrder.filter(
            (id) => id !== userId
        );

        if (room.started && room.currentPlayerId === userId) {
            clearTurnTimer(room);

            room.turnIndex = room.turnOrder.length
                ? oldIndex % room.turnOrder.length
                : 0;

            startTurn(io, room);
        }

        io.to(pin).emit("player:left", {
            playerId: userId,
            nickname: player.nickname,
        });

        emitPlayers(io, room);

        if (
            room.started &&
            [...room.players.values()].filter((item) => item.alive).length <= 1
        ) {
            const winner = [...room.players.values()]
                .find((item) => item.alive);

            finishGame(io, room, winner?.id || null);
        }
    }

    socket.leave(pin);
    delete socket.data.wordChainRoom;
}

module.exports = registerWordChainSocket;
