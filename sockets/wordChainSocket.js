
const crypto = require("crypto");
const {
    getWordSetForHost,
} = require("../services/wordChainService");

// =====================================================
// CẤU HÌNH GAME
// =====================================================

const TURN_TIME_LIMIT = 20;

// =====================================================
// SOCKET.IO GAME NỐI TỪ
// =====================================================

module.exports = function registerWordChainSocket(io) {
    const rooms = new Map();

    // =================================================
    // 1. ROOM HELPERS
    // =================================================

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

    function normalizeWord(value) {
        return String(value || "")
            .normalize("NFC")
            .trim()
            .toLowerCase()
            .replace(/\s+/g, " ");
    }

    function getFirstSyllable(word) {
        const normalized = normalizeWord(word);
        return normalized.split(" ")[0] || "";
    }

    function getLastSyllable(word) {
        const normalized = normalizeWord(word);
        const syllables = normalized.split(" ");

        return syllables[syllables.length - 1] || "";
    }

    // =================================================
    // 2. PLAYER HELPERS
    // =================================================

    function publicPlayers(room) {
        return room.playerOrder
            .map((socketId) => room.players.get(socketId))
            .filter(Boolean)
            .map((player) => ({
                id: player.id,
                nickname: player.nickname,
                alive: player.alive,
                isCurrentTurn: player.id === room.currentPlayerId,
            }));
    }

    function emitPlayers(pin, room) {
        io.to(pin).emit("room:players", {
            players: publicPlayers(room),
            totalPlayers: room.players.size,
            alivePlayers: room.playerOrder.filter((id) => {
                const player = room.players.get(id);
                return player && player.alive;
            }).length,
        });
    }

    function getAlivePlayers(room) {
        return room.playerOrder
            .map((id) => room.players.get(id))
            .filter((player) => player && player.alive);
    }

    function getNextAlivePlayer(room, currentId) {
        const alivePlayers = getAlivePlayers(room);

        if (alivePlayers.length === 0) {
            return null;
        }

        const currentIndex = room.playerOrder.indexOf(currentId);

        for (let i = 1; i <= room.playerOrder.length; i++) {
            const nextIndex =
                (currentIndex + i) % room.playerOrder.length;

            const nextId = room.playerOrder[nextIndex];
            const nextPlayer = room.players.get(nextId);

            if (nextPlayer && nextPlayer.alive) {
                return nextPlayer;
            }
        }

        return null;
    }

    // =================================================
    // 3. TIMER HELPERS
    // =================================================

    function clearTurnTimer(room) {
        if (room.turnTimer) {
            clearTimeout(room.turnTimer);
            room.turnTimer = null;
        }
    }

    function getRemainingSeconds(room) {
        if (!room.turnEndsAt) {
            return 0;
        }

        return Math.max(
            0,
            Math.ceil((room.turnEndsAt - Date.now()) / 1000)
        );
    }

    // =================================================
    // 4. GAME FINISH
    // =================================================

    function finishGame(pin, room, winner = null, reason = "normal") {
        if (!room || room.finished) {
            return;
        }

        clearTurnTimer(room);

        room.started = false;
        room.finished = true;
        room.currentPlayerId = null;
        room.turnEndsAt = null;

        const result = {
            pin,
            reason,
            winner: winner
                ? {
                    id: winner.id,
                    nickname: winner.nickname,
                }
                : null,
            players: publicPlayers(room),
            usedWords: room.usedWords,
            totalUsedWords: room.usedWords.length,
        };

        io.to(pin).emit("game:finished", result);

        console.log("WORD CHAIN GAME FINISHED:", {
            pin,
            winner: winner?.nickname || null,
            reason,
        });
    }

    function checkGameFinished(pin, room) {
        const alivePlayers = getAlivePlayers(room);

        if (alivePlayers.length <= 1) {
            finishGame(
                pin,
                room,
                alivePlayers[0] || null,
                "last-player-standing"
            );

            return true;
        }

        return false;
    }

    // =================================================
    // 5. START NEXT TURN
    // =================================================

    function startTurn(pin, room, player) {
        if (!room || room.finished || !room.started) {
            return;
        }

        clearTurnTimer(room);

        if (!player || !player.alive) {
            const nextPlayer = getNextAlivePlayer(
                room,
                room.currentPlayerId
            );

            if (!nextPlayer) {
                finishGame(pin, room, null, "no-player");
                return;
            }

            player = nextPlayer;
        }

        room.currentPlayerId = player.id;
        room.turnEndsAt = Date.now() + TURN_TIME_LIMIT * 1000;

        const lastWord =
            room.usedWords.length > 0
                ? room.usedWords[room.usedWords.length - 1]
                : null;

        const requiredSyllable = lastWord
            ? getLastSyllable(lastWord.word)
            : null;

        io.to(pin).emit("turn:started", {
            playerId: player.id,
            nickname: player.nickname,
            turnTimeLimit: TURN_TIME_LIMIT,
            endsAt: room.turnEndsAt,
            remainingSeconds: TURN_TIME_LIMIT,
            lastWord: lastWord?.word || null,
            requiredSyllable,
            usedWords: room.usedWords,
        });

        emitPlayers(pin, room);

        room.turnTimer = setTimeout(() => {
            const currentRoom = getRoom(pin);

            if (
                currentRoom !== room ||
                !room.started ||
                room.finished ||
                room.currentPlayerId !== player.id
            ) {
                return;
            }

            handleTurnTimeout(pin, room, player);
        }, TURN_TIME_LIMIT * 1000);

        console.log("TURN STARTED:", {
            pin,
            nickname: player.nickname,
            requiredSyllable,
        });
    }

    // =================================================
    // 6. HANDLE TIMEOUT
    // =================================================

    function handleTurnTimeout(pin, room, player) {
        if (
            !room ||
            room.finished ||
            !room.started ||
            room.currentPlayerId !== player.id
        ) {
            return;
        }

        clearTurnTimer(room);

        player.alive = false;

        io.to(pin).emit("player:eliminated", {
            playerId: player.id,
            nickname: player.nickname,
            reason: "timeout",
            message: `${player.nickname} đã hết thời gian và bị loại.`,
        });

        room.currentPlayerId = null;
        room.turnEndsAt = null;

        emitPlayers(pin, room);

        if (checkGameFinished(pin, room)) {
            return;
        }

        const nextPlayer = getNextAlivePlayer(room, player.id);

        if (nextPlayer) {
            startTurn(pin, room, nextPlayer);
        }
    }

    // =================================================
    // 7. CONNECTION
    // =================================================

    io.on("connection", (socket) => {
        console.log("WORD CHAIN SOCKET CONNECTED:", socket.id);

        // =============================================
        // HOST: CREATE ROOM
        // =============================================

        socket.on("host:create", async (data = {}, callback) => {
            const ack =
                typeof callback === "function"
                    ? callback
                    : () => {};

            try {
                const wordSetId = data.wordSetId;

                if (!wordSetId) {
                    return ack({
                        ok: false,
                        message: "Vui lòng chọn bộ từ.",
                    });
                }

                // Lấy bộ từ đã duyệt từ Supabase
                const wordSet = await getWordSetForHost(wordSetId);

                if (
                    !wordSet.words ||
                    !Array.isArray(wordSet.words) ||
                    wordSet.words.length < 2
                ) {
                    return ack({
                        ok: false,
                        message: "Bộ từ cần có ít nhất 2 từ hợp lệ.",
                    });
                }

                // Chuẩn hóa dữ liệu từ vựng
                const normalizedWords = wordSet.words
                    .map((item) => {
                        const word = String(item.word || "").trim();

                        return {
                            word,
                            normalized_word: normalizeWord(
                                item.normalized_word || word
                            ),
                        };
                    })
                    .filter((item) => {
                        return (
                            item.word &&
                            item.normalized_word
                        );
                    });

                if (normalizedWords.length < 2) {
                    return ack({
                        ok: false,
                        message: "Bộ từ không có đủ từ hợp lệ để chơi.",
                    });
                }

                // Tạo danh sách từ hợp lệ để tra cứu nhanh
                const wordMap = new Map();

                for (const item of normalizedWords) {
                    if (!wordMap.has(item.normalized_word)) {
                        wordMap.set(item.normalized_word, item.word);
                    }
                }

                const pin = createPin();

                const room = {
                    pin,

                    title: wordSet.title,
                    wordSetId: wordSet.id,
                    wordSetTitle: wordSet.title,

                    hostSocketId: socket.id,

                    // Danh sách từ của bộ Excel
                    words: normalizedWords,
                    wordMap,

                    // Người chơi
                    players: new Map(),
                    playerOrder: [],

                    // Trạng thái game
                    started: false,
                    finished: false,

                    currentPlayerId: null,

                    // Lịch sử từ chỉ lưu trong RAM
                    usedWords: [],
                    usedWordSet: new Set(),

                    // Timer
                    turnTimer: null,
                    turnEndsAt: null,
                };

                rooms.set(pin, room);

                socket.join(pin);
                socket.data.hostPin = pin;

                console.log("WORD CHAIN ROOM CREATED:", {
                    pin,
                    wordSetId: wordSet.id,
                    title: wordSet.title,
                    totalWords: normalizedWords.length,
                });

                return ack({
                    ok: true,
                    pin,
                    title: wordSet.title,
                    wordSetId: wordSet.id,
                    totalWords: normalizedWords.length,
                });

            } catch (error) {
                console.error("HOST CREATE ERROR:", error);

                return ack({
                    ok: false,
                    message:
                        error.message || "Không thể tạo phòng.",
                });
            }
        });

        // =============================================
        // PLAYER: JOIN ROOM
        // =============================================

        socket.on("player:join", (data = {}, callback) => {
            const ack =
                typeof callback === "function"
                    ? callback
                    : () => {};

            const pin = String(data.pin || "").trim();

            const nickname = String(data.nickname || "")
                .trim()
                .slice(0, 24);

            const room = getRoom(pin);

            if (!room) {
                return ack({
                    ok: false,
                    message: "Không tìm thấy phòng. Vui lòng kiểm tra PIN.",
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

            // Tránh nickname trùng trong cùng phòng
            const duplicateNickname = [...room.players.values()].some(
                (player) =>
                    player.nickname.toLowerCase() ===
                    nickname.toLowerCase()
            );

            if (duplicateNickname) {
                return ack({
                    ok: false,
                    message: "Nickname này đã có người sử dụng.",
                });
            }

            // Nếu socket đang ở phòng khác thì rời phòng cũ
            const oldPin = socket.data.playerPin;

            if (oldPin && oldPin !== pin) {
                const oldRoom = getRoom(oldPin);

                if (oldRoom) {
                    oldRoom.players.delete(socket.id);

                    oldRoom.playerOrder =
                        oldRoom.playerOrder.filter(
                            (id) => id !== socket.id
                        );

                    emitPlayers(oldPin, oldRoom);

                    if (oldRoom.started) {
                        checkGameFinished(oldPin, oldRoom);
                    }
                }

                socket.leave(oldPin);
            }

            const player = {
                id: socket.id,
                nickname,
                alive: true,
                joinedAt: Date.now(),
            };

            room.players.set(socket.id, player);
            room.playerOrder.push(socket.id);

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

        // =============================================
        // HOST: START GAME
        // =============================================

        socket.on("host:start", (data = {}, callback) => {
            const ack =
                typeof callback === "function"
                    ? callback
                    : () => {};

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

            const players = getAlivePlayers(room);

            if (players.length < 2) {
                return ack({
                    ok: false,
                    message: "Cần ít nhất 2 người chơi để bắt đầu.",
                });
            }

            if (room.words.length < 2) {
                return ack({
                    ok: false,
                    message: "Bộ từ không đủ dữ liệu.",
                });
            }

            room.started = true;
            room.finished = false;
            room.usedWords = [];
            room.usedWordSet = new Set();

            // Chọn người chơi đầu tiên ngẫu nhiên
            const firstPlayer =
                players[crypto.randomInt(0, players.length)];

            io.to(room.pin).emit("game:started", {
                pin: room.pin,
                title: room.title,
                wordSetTitle: room.wordSetTitle,
                totalWords: room.words.length,
                totalPlayers: players.length,
                turnTimeLimit: TURN_TIME_LIMIT,
            });

            startTurn(room.pin, room, firstPlayer);

            return ack({
                ok: true,
                message: "Trận đấu đã bắt đầu.",
                firstPlayer: firstPlayer.nickname,
            });
        });

        // =============================================
        // PLAYER: SUBMIT WORD
        // =============================================

        socket.on("player:submit-word", (data = {}, callback) => {
            const ack =
                typeof callback === "function"
                    ? callback
                    : () => {};

            const pin = String(data.pin || "").trim();
            const inputWord = String(data.word || "").trim();

            const room = getRoom(pin);

            if (
                !room ||
                !room.started ||
                room.finished
            ) {
                return ack({
                    ok: false,
                    message: "Phòng chưa bắt đầu hoặc đã kết thúc.",
                });
            }

            const player = room.players.get(socket.id);

            if (
                !player ||
                !player.alive ||
                socket.data.playerPin !== pin
            ) {
                return ack({
                    ok: false,
                    message: "Bạn không ở trong phòng chơi.",
                });
            }

            if (room.currentPlayerId !== socket.id) {
                return ack({
                    ok: false,
                    message: "Chưa đến lượt của bạn.",
                });
            }

            if (!inputWord) {
                return ack({
                    ok: false,
                    message: "Vui lòng nhập từ nối.",
                });
            }

            if (!room.turnEndsAt || Date.now() >= room.turnEndsAt) {
                handleTurnTimeout(pin, room, player);

                return ack({
                    ok: false,
                    message: "Đã hết thời gian lượt chơi.",
                });
            }

            const normalizedWord = normalizeWord(inputWord);

            // Kiểm tra từ có trong bộ Excel không
            const officialWord = room.wordMap.get(normalizedWord);

            if (!officialWord) {
                return ack({
                    ok: false,
                    message: "Từ này không có trong bộ từ đã chọn.",
                });
            }

            // Kiểm tra từ đã được sử dụng chưa
            if (room.usedWordSet.has(normalizedWord)) {
                return ack({
                    ok: false,
                    message: "Từ này đã được sử dụng.",
                });
            }

            // Kiểm tra nối từ
            const lastUsedWord =
                room.usedWords.length > 0
                    ? room.usedWords[room.usedWords.length - 1]
                    : null;

            if (lastUsedWord) {
                const requiredSyllable = getLastSyllable(
                    lastUsedWord.word
                );

                const firstSyllable = getFirstSyllable(
                    officialWord
                );

                if (firstSyllable !== requiredSyllable) {
                    return ack({
                        ok: false,
                        message: `Từ phải bắt đầu bằng tiếng "${requiredSyllable}".`,
                        requiredSyllable,
                    });
                }
            }

            // Chấp nhận từ
            clearTurnTimer(room);

            const usedWord = {
                word: officialWord,
                normalized_word: normalizedWord,
                playerId: player.id,
                nickname: player.nickname,
                playedAt: Date.now(),
            };

            room.usedWords.push(usedWord);
            room.usedWordSet.add(normalizedWord);

            io.to(pin).emit("word:accepted", {
                word: officialWord,
                playerId: player.id,
                nickname: player.nickname,
                turnNumber: room.usedWords.length,
                usedWords: room.usedWords,
            });

            // Cập nhật lượt
            room.currentPlayerId = null;
            room.turnEndsAt = null;

            // Hết từ hợp lệ có thể chơi tiếp
            const availableWords = room.words.filter((item) => {
                const normalized = normalizeWord(
                    item.normalized_word || item.word
                );

                if (room.usedWordSet.has(normalized)) {
                    return false;
                }

                const requiredSyllable = getLastSyllable(
                    officialWord
                );

                return (
                    getFirstSyllable(item.word) ===
                    requiredSyllable
                );
            });

            // Nếu không còn từ nối hợp lệ, người vừa đi được tính thắng
            if (availableWords.length === 0) {
                finishGame(
                    pin,
                    room,
                    player,
                    "no-more-words"
                );

                return ack({
                    ok: true,
                    message: "Từ hợp lệ. Bạn đã chiến thắng!",
                    word: officialWord,
                    finished: true,
                });
            }

            const nextPlayer = getNextAlivePlayer(
                room,
                player.id
            );

            if (!nextPlayer) {
                finishGame(
                    pin,
                    room,
                    player,
                    "last-player-standing"
                );

                return ack({
                    ok: true,
                    message: "Bạn đã chiến thắng!",
                    word: officialWord,
                    finished: true,
                });
            }

            emitPlayers(pin, room);
            startTurn(pin, room, nextPlayer);

            return ack({
                ok: true,
                message: "Nối từ thành công.",
                word: officialWord,
                nextPlayer: nextPlayer.nickname,
            });
        });

        // =============================================
        // HOST: CLOSE ROOM
        // =============================================

        socket.on("host:close", (data = {}, callback) => {
            const ack =
                typeof callback === "function"
                    ? callback
                    : () => {};

            const room = getRoom(data.pin);

            if (!isHost(socket, room)) {
                return ack({
                    ok: false,
                    message: "Bạn không phải chủ phòng.",
                });
            }

            clearTurnTimer(room);

            io.to(room.pin).emit("room:closed", {
                message: "Chủ phòng đã đóng phòng.",
            });

            for (const player of room.players.values()) {
                const playerSocket = io.sockets.sockets.get(
                    player.id
                );

                if (playerSocket) {
                    playerSocket.data.playerPin = null;
                    playerSocket.leave(room.pin);
                }
            }

            rooms.delete(room.pin);

            socket.data.hostPin = null;

            return ack({
                ok: true,
                message: "Đã đóng phòng.",
            });
        });

        // =============================================
        // PLAYER: LEAVE ROOM
        // =============================================

        socket.on("player:leave", (data = {}, callback) => {
            const ack =
                typeof callback === "function"
                    ? callback
                    : () => {};

            const pin = String(
                data.pin || socket.data.playerPin || ""
            ).trim();

            const room = getRoom(pin);

            if (!room) {
                socket.data.playerPin = null;

                return ack({
                    ok: true,
                });
            }

            const player = room.players.get(socket.id);

            if (!player) {
                return ack({
                    ok: false,
                    message: "Không tìm thấy người chơi.",
                });
            }

            room.players.delete(socket.id);

            room.playerOrder = room.playerOrder.filter(
                (id) => id !== socket.id
            );

            socket.leave(pin);
            socket.data.playerPin = null;

            io.to(pin).emit("player:left", {
                playerId: socket.id,
                nickname: player.nickname,
            });

            emitPlayers(pin, room);

            if (room.started && !room.finished) {
                if (room.currentPlayerId === socket.id) {
                    clearTurnTimer(room);

                    room.currentPlayerId = null;
                    room.turnEndsAt = null;

                    if (!checkGameFinished(pin, room)) {
                        const nextPlayer = getNextAlivePlayer(
                            room,
                            socket.id
                        );

                        if (nextPlayer) {
                            startTurn(pin, room, nextPlayer);
                        }
                    }
                } else {
                    checkGameFinished(pin, room);
                }
            }

            return ack({
                ok: true,
                message: "Đã rời phòng.",
            });
        });

        // =============================================
        // DISCONNECT
        // =============================================

        socket.on("disconnect", (reason) => {
            console.log(
                "WORD CHAIN SOCKET DISCONNECTED:",
                socket.id,
                reason
            );

            // Host disconnect
            const hostPin = socket.data.hostPin;

            if (hostPin) {
                const hostRoom = getRoom(hostPin);

                if (
                    hostRoom &&
                    hostRoom.hostSocketId === socket.id
                ) {
                    clearTurnTimer(hostRoom);

                    io.to(hostPin).emit("room:closed", {
                        message: "Chủ phòng đã ngắt kết nối.",
                    });

                    rooms.delete(hostPin);
                }
            }

            // Player disconnect
            const playerPin = socket.data.playerPin;

            if (playerPin) {
                const playerRoom = getRoom(playerPin);

                if (playerRoom) {
                    const player = playerRoom.players.get(
                        socket.id
                    );

                    playerRoom.players.delete(socket.id);

                    playerRoom.playerOrder =
                        playerRoom.playerOrder.filter(
                            (id) => id !== socket.id
                        );

                    if (player) {
                        io.to(playerPin).emit("player:left", {
                            playerId: socket.id,
                            nickname: player.nickname,
                        });
                    }

                    emitPlayers(playerPin, playerRoom);

                    if (
                        playerRoom.started &&
                        !playerRoom.finished
                    ) {
                        if (
                            playerRoom.currentPlayerId === socket.id
                        ) {
                            clearTurnTimer(playerRoom);

                            playerRoom.currentPlayerId = null;
                            playerRoom.turnEndsAt = null;

                            if (
                                !checkGameFinished(
                                    playerPin,
                                    playerRoom
                                )
                            ) {
                                const nextPlayer =
                                    getNextAlivePlayer(
                                        playerRoom,
                                        socket.id
                                    );

                                if (nextPlayer) {
                                    startTurn(
                                        playerPin,
                                        playerRoom,
                                        nextPlayer
                                    );
                                }
                            }
                        } else {
                            checkGameFinished(
                                playerPin,
                                playerRoom
                            );
                        }
                    }
                }
            }
        });
    });

    // =================================================
    // 8. ROOM STATUS
    // =================================================

    return {
        getRoomStatus() {
            return {
                count: rooms.size,
                pins: [...rooms.keys()],
            };
        },
    };
};
