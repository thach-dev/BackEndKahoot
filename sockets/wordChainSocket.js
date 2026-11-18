
const { randomInt } = require("crypto");

const wordChainService = require("../services/wordChainService");

const MAX_PLAYERS = 20;

module.exports = function registerWordChainSocket(io) {
    const rooms = new Map();

    // =====================================================
    // TẠO MÃ PHÒNG
    // =====================================================

    function makePin() {
        let pin;

        do {
            pin = String(randomInt(100000, 1000000));
        } while (rooms.has(pin));

        return pin;
    }

    // =====================================================
    // XÁO TRỘN
    // =====================================================

    function shuffle(array) {
        const result = [...array];

        for (let i = result.length - 1; i > 0; i--) {
            const j = randomInt(i + 1);

            [result[i], result[j]] = [
                result[j],
                result[i],
            ];
        }

        return result;
    }

    // =====================================================
    // CHUẨN HÓA DỮ LIỆU GHÉP ĐÔI
    //
    // Hỗ trợ:
    // { left_text, right_text }
    // { question, answer }
    // { prompt, answer }
    // { term, definition }
    // { word, meaning }
    // { question, correct_answer }
    //
    // Hoặc dữ liệu questions/options đã có sẵn.
    // =====================================================

    function buildMatchingData(wordSet) {
        if (!wordSet) {
            throw new Error(
                "Không tìm thấy bộ dữ liệu."
            );
        }

        let questions = [];
        let options = [];

        // Trường hợp dữ liệu đã có questions/options
        if (
            Array.isArray(wordSet.questions) &&
            Array.isArray(wordSet.options)
        ) {
            questions = wordSet.questions.map(
                (item, index) => ({
                    id: String(
                        item.id ?? `Q${index + 1}`
                    ).trim(),

                    left_text: String(
                        item.left_text ?? item.question ?? ""
                    ).trim(),

                    correct_option_key: String(
                        item.correct_option_key ?? ""
                    ).trim().toUpperCase(),
                })
            );

            options = wordSet.options.map(
                (item, index) => ({
                    option_key: String(
                        item.option_key ?? `A${index + 1}`
                    ).trim().toUpperCase(),

                    right_text: String(
                        item.right_text ?? item.answer ?? ""
                    ).trim(),
                })
            );
        } else {
            // Trường hợp dữ liệu được lưu trong words JSONB
            const sourceWords = wordSet.words;

            if (
                !Array.isArray(sourceWords) ||
                sourceWords.length === 0
            ) {
                throw new Error(
                    "Bộ dữ liệu không có nội dung ghép đôi."
                );
            }

            const pairs = sourceWords.map(
                (item, index) => {
                    if (
                        !item ||
                        typeof item !== "object" ||
                        Array.isArray(item)
                    ) {
                        throw new Error(
                            `Dữ liệu thứ ${index + 1} không phải một cặp ghép.`
                        );
                    }

                    const leftText = String(
                        item.left_text ??
                        item.question ??
                        item.prompt ??
                        item.term ??
                        item.word ??
                        ""
                    ).trim();

                    const rightText = String(
                        item.right_text ??
                        item.answer ??
                        item.meaning ??
                        item.definition ??
                        item.translation ??
                        item.correct_answer ??
                        ""
                    ).trim();

                    if (!leftText || !rightText) {
                        throw new Error(
                            `Dữ liệu thứ ${index + 1} thiếu câu hỏi hoặc đáp án.`
                        );
                    }

                    return {
                        id: String(
                            item.id ?? `Q${index + 1}`
                        ).trim(),

                        left_text: leftText,
                        right_text: rightText,

                        correct_option_key: String(
                            item.correct_option_key ?? ""
                        ).trim().toUpperCase(),
                    };
                }
            );

            const optionKeySet = new Set();

            options = pairs.map((pair, index) => {
                const optionKey = `A${index + 1}`;

                optionKeySet.add(optionKey);

                return {
                    option_key: optionKey,
                    right_text: pair.right_text,
                };
            });

            questions = pairs.map((pair, index) => ({
                id: pair.id,
                left_text: pair.left_text,

                correct_option_key:
                    pair.correct_option_key || `A${index + 1}`,
            }));
        }

        // =================================================
        // KIỂM TRA SỐ LƯỢNG
        // =================================================

        if (
            questions.length < 1 ||
            questions.length > 1000
        ) {
            throw new Error(
                "Bộ câu hỏi phải có từ 1 đến 1000 câu."
            );
        }

        if (
            options.length < 1 ||
            options.length > 1000
        ) {
            throw new Error(
                "Bộ đáp án phải có từ 1 đến 1000 đáp án."
            );
        }

        // =================================================
        // KIỂM TRA CÂU HỎI
        // =================================================

        const questionIds = new Set();

        questions = questions.map((question, index) => {
            const id = String(
                question.id ?? ""
            ).trim();

            const leftText = String(
                question.left_text ?? ""
            ).trim();

            const correctKey = String(
                question.correct_option_key ?? ""
            ).trim().toUpperCase();

            if (!id || !leftText || !correctKey) {
                throw new Error(
                    `Câu hỏi thứ ${index + 1} không hợp lệ.`
                );
            }

            if (questionIds.has(id)) {
                throw new Error(
                    `ID câu hỏi ${id} bị trùng.`
                );
            }

            questionIds.add(id);

            return {
                id,
                left_text: leftText,
                correct_option_key: correctKey,
            };
        });

        // =================================================
        // KIỂM TRA ĐÁP ÁN
        // =================================================

        const optionKeys = new Set();

        options = options.map((option, index) => {
            const key = String(
                option.option_key ?? ""
            ).trim().toUpperCase();

            const rightText = String(
                option.right_text ?? ""
            ).trim();

            if (!key || !rightText) {
                throw new Error(
                    `Phương án thứ ${index + 1} không hợp lệ.`
                );
            }

            if (optionKeys.has(key)) {
                throw new Error(
                    `Mã đáp án ${key} bị trùng.`
                );
            }

            optionKeys.add(key);

            return {
                option_key: key,
                right_text: rightText,
            };
        });

        // =================================================
        // KIỂM TRA ĐÁP ÁN ĐÚNG
        // =================================================

        for (const question of questions) {
            if (
                !optionKeys.has(
                    question.correct_option_key
                )
            ) {
                throw new Error(
                    `Câu hỏi ${question.id} có đáp án không tồn tại: ${question.correct_option_key}`
                );
            }
        }

        return {
            questions,
            options,
        };
    }

    // =====================================================
    // DỮ LIỆU CÔNG KHAI
    // KHÔNG GỬI ĐÁP ÁN ĐÚNG CHO NGƯỜI CHƠI
    // =====================================================

    function getPublicGameData(room) {
        return {
            gameType: "MATCHING",
            title: room.title,

            questions: room.questions.map(question => ({
                id: question.id,
                left_text: question.left_text,
            })),

            options: room.options.map(option => ({
                option_key: option.option_key,
                right_text: option.right_text,
            })),
        };
    }

    // =====================================================
    // DANH SÁCH NGƯỜI CHƠI
    // =====================================================

    function getPublicPlayers(room) {
        return [...room.players.values()].map(player => ({
            id: player.id,
            nickname: player.nickname,
            isHost: false,
            submitted: player.submitted,
        }));
    }

    function broadcastPlayers(room) {
        io.to(room.pin).emit(
            "matching:room:players",
            {
                players: getPublicPlayers(room),
            }
        );
    }

    // =====================================================
    // TÍNH ĐIỂM
    // =====================================================

    function calculateResult(room, answers) {
        let correct = 0;
        let wrong = 0;
        let unanswered = 0;

        const details = room.questions.map(question => {
            const submittedKey = String(
                answers?.[question.id] ?? ""
            ).trim().toUpperCase();

            const correctKey = String(
                question.correct_option_key
            ).toUpperCase();

            const isCorrect =
                submittedKey !== "" &&
                submittedKey !== "0" &&
                submittedKey === correctKey;

            if (!submittedKey || submittedKey === "0") {
                unanswered++;
            } else if (isCorrect) {
                correct++;
            } else {
                wrong++;
            }

            return {
                questionId: question.id,
                selectedOption: submittedKey || null,
                correct: isCorrect,
            };
        });

        return {
            correct,
            wrong,
            unanswered,
            total: room.questions.length,
            score: correct * 100,
            details,
        };
    }

    // =====================================================
    // KẾT THÚC TRẬN
    // =====================================================

    function finishGame(room) {
        if (!room || room.finished) return;

        room.finished = true;

        const leaderboard = [...room.players.values()]
            .map(player => ({
                id: player.id,
                nickname: player.nickname,
                score: player.score,
                submitted: player.submitted,

                result: player.result
                    ? {
                        correct: player.result.correct,
                        wrong: player.result.wrong,
                        unanswered: player.result.unanswered,
                        total: player.result.total,
                    }
                    : null,
            }))
            .sort((a, b) => b.score - a.score);

        // Chỉ host nhận đáp án chuẩn
        io.to(room.hostSocketId).emit(
            "matching:host:answer-key",
            {
                answers: Object.fromEntries(
                    room.questions.map(question => [
                        question.id,
                        question.correct_option_key,
                    ])
                ),
            }
        );

        io.to(room.pin).emit(
            "matching:game:finished",
            {
                leaderboard,
            }
        );

        console.log(
            "[MATCHING] GAME FINISHED:",
            room.pin
        );
    }

    function checkAllSubmitted(room) {
        if (!room || room.finished) return;

        if (room.players.size === 0) return;

        const allSubmitted = [
            ...room.players.values(),
        ].every(player => player.submitted);

        if (allSubmitted) {
            finishGame(room);
        }
    }

    // =====================================================
    // XÓA PHÒNG
    // =====================================================

    function closeRoom(room, message) {
        if (!room) return;

        io.to(room.pin).emit(
            "matching:room:closed",
            {
                message,
            }
        );

        for (const player of room.players.values()) {
            const playerSocket = io.sockets.sockets.get(
                player.id
            );

            if (playerSocket) {
                playerSocket.data.matchingPlayerPin = null;
                playerSocket.leave(room.pin);
            }
        }

        const hostSocket = io.sockets.sockets.get(
            room.hostSocketId
        );

        if (hostSocket) {
            hostSocket.data.matchingHostPin = null;
            hostSocket.leave(room.pin);
        }

        rooms.delete(room.pin);

        console.log(
            "[MATCHING] ROOM CLOSED:",
            room.pin
        );
    }

    // =====================================================
    // SOCKET CONNECTION
    // =====================================================

    io.on("connection", socket => {
        console.log("[MATCHING] CLIENT CONNECTED:", {
            socketId: socket.id,
            userId: socket.data.userId,
            transport: socket.conn.transport.name,
        });

        socket.onAny(event => {
            console.log("[MATCHING] EVENT RECEIVED:", {
                event,
                socketId: socket.id,
                userId: socket.data.userId,
            });
        });

        // =================================================
        // 1. HOST CREATE ROOM
        // =================================================

        socket.on(
            "matching:host:create",
            async (data = {}, callback = () => {}) => {
                const ack =
                    typeof callback === "function"
                        ? callback
                        : () => {};

                const wordSetId = data?.wordSetId;

                console.log(
                    "[MATCHING] CREATE REQUEST RECEIVED:",
                    {
                        socketId: socket.id,
                        userId: socket.data.userId,
                        wordSetId,
                    }
                );

                try {
                    if (!wordSetId) {
                        throw new Error(
                            "Vui lòng chọn bộ dữ liệu."
                        );
                    }

                    if (socket.data.matchingHostPin) {
                        const oldRoom = rooms.get(
                            socket.data.matchingHostPin
                        );

                        if (oldRoom) {
                            closeRoom(
                                oldRoom,
                                "Chủ phòng đã tạo phòng mới."
                            );
                        }
                    }

                    console.log(
                        "[MATCHING] STEP 1: GET WORD SET"
                    );

                    const wordSet =
                        await wordChainService.getWordSetForHost(
                            wordSetId
                        );

                    console.log(
                        "[MATCHING] STEP 2: WORD SET LOADED:",
                        {
                            title: wordSet.title,
                            totalWords: wordSet.words?.length,
                        }
                    );

                    const validated = buildMatchingData(
                        wordSet
                    );

                    console.log(
                        "[MATCHING] STEP 3: VALIDATION SUCCESS:",
                        {
                            questions: validated.questions.length,
                            options: validated.options.length,
                        }
                    );

                    const pin = makePin();

                    const room = {
                        pin,
                        title: wordSet.title || "Bộ ghép đôi",
                        wordSetId,

                        hostSocketId: socket.id,

                        players: new Map(),

                        questions: shuffle(
                            validated.questions
                        ),

                        options: shuffle(
                            validated.options
                        ),

                        started: false,
                        finished: false,
                    };

                    rooms.set(pin, room);

                    await socket.join(pin);

                    socket.data.matchingHostPin = pin;

                    console.log(
                        "[MATCHING] STEP 4: ROOM CREATED:",
                        {
                            pin,
                            title: room.title,
                            questions: room.questions.length,
                            options: room.options.length,
                        }
                    );

                    ack({
                        ok: true,
                        pin,
                        title: room.title,
                        totalQuestions: room.questions.length,
                        totalOptions: room.options.length,
                    });
                } catch (error) {
                    console.error(
                        "[MATCHING] CREATE ROOM FAILED:",
                        {
                            message: error.message,
                            stack: error.stack,
                            wordSetId,
                            socketId: socket.id,
                        }
                    );

                    ack({
                        ok: false,
                        message:
                            error.message ||
                            "Không thể tạo phòng.",
                    });
                }
            }
        );

        // =================================================
        // 2. PLAYER JOIN
        // =================================================

        socket.on(
            "matching:player:join",
            async (
                { pin, nickname } = {},
                callback = () => {}
            ) => {
                const ack =
                    typeof callback === "function"
                        ? callback
                        : () => {};

                try {
                    pin = String(pin || "").trim();

                    nickname = String(nickname || "")
                        .trim()
                        .slice(0, 20);

                    const room = rooms.get(pin);

                    if (!room) {
                        return ack({
                            ok: false,
                            message: "Mã phòng không tồn tại.",
                        });
                    }

                    if (room.started || room.finished) {
                        return ack({
                            ok: false,
                            message:
                                "Trận đấu đã bắt đầu hoặc kết thúc.",
                        });
                    }

                    if (!nickname) {
                        return ack({
                            ok: false,
                            message:
                                "Vui lòng nhập nickname.",
                        });
                    }

                    if (room.players.size >= MAX_PLAYERS) {
                        return ack({
                            ok: false,
                            message: "Phòng đã đủ người.",
                        });
                    }

                    if (
                        socket.data.matchingPlayerPin &&
                        socket.data.matchingPlayerPin !== pin
                    ) {
                        return ack({
                            ok: false,
                            message:
                                "Bạn đang ở một phòng khác.",
                        });
                    }

                    // Tránh người chơi tham gia lặp
                    if (room.players.has(socket.id)) {
                        return ack({
                            ok: false,
                            message:
                                "Bạn đã tham gia phòng này.",
                        });
                    }

                    const player = {
                        id: socket.id,
                        nickname,
                        submitted: false,
                        score: 0,
                        result: null,
                    };

                    room.players.set(socket.id, player);

                    await socket.join(pin);

                    socket.data.matchingPlayerPin = pin;

                    broadcastPlayers(room);

                    ack({
                        ok: true,
                        pin,
                        playerId: socket.id,
                        nickname,
                    });
                } catch (error) {
                    console.error(
                        "[MATCHING] PLAYER JOIN ERROR:",
                        error
                    );

                    ack({
                        ok: false,
                        message: "Không thể tham gia phòng.",
                    });
                }
            }
        );

        // =================================================
        // 3. HOST START GAME
        // =================================================

        socket.on(
            "matching:host:start",
            ({ pin } = {}, callback = () => {}) => {
                const ack =
                    typeof callback === "function"
                        ? callback
                        : () => {};

                try {
                    const room = rooms.get(
                        String(
                            pin || socket.data.matchingHostPin || ""
                        ).trim()
                    );

                    if (
                        !room ||
                        room.hostSocketId !== socket.id
                    ) {
                        return ack({
                            ok: false,
                            message:
                                "Không có quyền điều khiển phòng.",
                        });
                    }

                    if (room.started || room.finished) {
                        return ack({
                            ok: false,
                            message:
                                "Trận đấu đã bắt đầu hoặc kết thúc.",
                        });
                    }

                    if (room.questions.length < 1 || room.options.length < 1) {
                        return ack({
                            ok: false,
                            message:
                                "Bộ dữ liệu không có câu hỏi hoặc đáp án.",
                        });
                    }

                    if (room.players.size < 1) {
                        return ack({
                            ok: false,
                            message:
                                "Cần ít nhất một người chơi.",
                        });
                    }

                    room.started = true;

                    // Không gửi đáp án đúng xuống client
                    io.to(room.pin).emit(
                        "matching:game:started",
                        {
                            ...getPublicGameData(room),
                            totalQuestions: room.questions.length,
                            totalOptions: room.options.length,
                        }
                    );

                    console.log(
                        "[MATCHING] GAME STARTED:",
                        room.pin
                    );

                    ack({
                        ok: true,
                    });
                } catch (error) {
                    console.error(
                        "[MATCHING] HOST START ERROR:",
                        error
                    );

                    ack({
                        ok: false,
                        message: "Không thể bắt đầu trận đấu.",
                    });
                }
            }
        );

        // =================================================
        // 4. PLAYER SUBMIT
        // =================================================

        socket.on(
            "matching:player:submit",
            (
                { pin, answers } = {},
                callback = () => {}
            ) => {
                const ack =
                    typeof callback === "function"
                        ? callback
                        : () => {};

                try {
                    const room = rooms.get(
                        String(pin || "").trim()
                    );

                    if (
                        !room ||
                        socket.data.matchingPlayerPin !== room.pin ||
                        !room.started ||
                        room.finished
                    ) {
                        return ack({
                            ok: false,
                            message:
                                "Không thể gửi kết quả.",
                        });
                    }

                    const player = room.players.get(
                        socket.id
                    );

                    if (!player) {
                        return ack({
                            ok: false,
                            message:
                                "Bạn không thuộc phòng này.",
                        });
                    }

                    if (player.submitted) {
                        return ack({
                            ok: false,
                            message:
                                "Bạn đã nộp bài rồi.",
                        });
                    }

                    if (
                        !answers ||
                        typeof answers !== "object" ||
                        Array.isArray(answers)
                    ) {
                        return ack({
                            ok: false,
                            message:
                                "Dữ liệu ghép nối không hợp lệ.",
                        });
                    }

                    const validQuestionIds = new Set(
                        room.questions.map(
                            question => question.id
                        )
                    );

                    const validOptionKeys = new Set(
                        room.options.map(
                            option => option.option_key
                        )
                    );

                    for (const [
                        questionId,
                        optionKey,
                    ] of Object.entries(answers)) {
                        if (!validQuestionIds.has(String(questionId))) {
                            return ack({
                                ok: false,
                                message:
                                    "Có câu hỏi không hợp lệ.",
                            });
                        }

                        const selected = String(
                            optionKey
                        ).trim().toUpperCase();

                        if (
                            selected !== "0" &&
                            !validOptionKeys.has(selected)
                        ) {
                            return ack({
                                ok: false,
                                message:
                                    "Có đáp án không hợp lệ.",
                            });
                        }
                    }

                    const result = calculateResult(
                        room,
                        answers
                    );

                    player.submitted = true;
                    player.score = result.score;
                    player.result = result;

                    ack({
                        ok: true,
                        result: {
                            correct: result.correct,
                            wrong: result.wrong,
                            unanswered: result.unanswered,
                            total: result.total,
                            score: result.score,
                        },
                    });

                    io.to(room.hostSocketId).emit(
                        "matching:host:submission",
                        {
                            playerId: socket.id,
                            nickname: player.nickname,
                            submitted: true,
                        }
                    );

                    broadcastPlayers(room);

                    checkAllSubmitted(room);
                } catch (error) {
                    console.error(
                        "[MATCHING] PLAYER SUBMIT ERROR:",
                        error
                    );

                    ack({
                        ok: false,
                        message:
                            "Không thể gửi kết quả.",
                    });
                }
            }
        );

        // =================================================
        // 5. HOST FINISH
        // =================================================

        socket.on(
            "matching:host:finish",
            ({ pin } = {}, callback = () => {}) => {
                const ack =
                    typeof callback === "function"
                        ? callback
                        : () => {};

                const room = rooms.get(
                    String(
                        pin || socket.data.matchingHostPin || ""
                    ).trim()
                );

                if (
                    !room ||
                    room.hostSocketId !== socket.id
                ) {
                    return ack({
                        ok: false,
                        message:
                            "Không có quyền kết thúc trận.",
                    });
                }

                finishGame(room);

                ack({
                    ok: true,
                });
            }
        );

        // =================================================
        // 6. PLAYER LEAVE
        // =================================================

        socket.on(
            "matching:player:leave",
            ({ pin } = {}, callback = () => {}) => {
                const ack =
                    typeof callback === "function"
                        ? callback
                        : () => {};

                const room = rooms.get(
                    String(
                        pin || socket.data.matchingPlayerPin || ""
                    ).trim()
                );

                if (
                    room &&
                    room.players.has(socket.id)
                ) {
                    room.players.delete(socket.id);

                    socket.leave(room.pin);

                    broadcastPlayers(room);

                    checkAllSubmitted(room);
                }

                socket.data.matchingPlayerPin = null;

                ack({
                    ok: true,
                });
            }
        );

        // =================================================
        // 7. HOST CLOSE ROOM
        // =================================================

        socket.on(
            "matching:host:close",
            ({ pin } = {}, callback = () => {}) => {
                const ack =
                    typeof callback === "function"
                        ? callback
                        : () => {};

                const room = rooms.get(
                    String(
                        pin || socket.data.matchingHostPin || ""
                    ).trim()
                );

                if (
                    !room ||
                    room.hostSocketId !== socket.id
                ) {
                    return ack({
                        ok: false,
                        message:
                            "Không có quyền đóng phòng.",
                    });
                }

                closeRoom(
                    room,
                    "Chủ phòng đã đóng phòng."
                );

                ack({
                    ok: true,
                });
            }
        );

        // =================================================
        // 8. DISCONNECT
        // =================================================

        socket.on("disconnect", () => {
            // Người chơi mất kết nối
            const playerPin =
                socket.data.matchingPlayerPin;

            const playerRoom = rooms.get(playerPin);

            if (
                playerRoom &&
                playerRoom.players.has(socket.id)
            ) {
                playerRoom.players.delete(socket.id);

                broadcastPlayers(playerRoom);

                checkAllSubmitted(playerRoom);

                console.log(
                    "[MATCHING] PLAYER DISCONNECTED:",
                    socket.id
                );
            }

            // Chủ phòng mất kết nối
            const hostPin =
                socket.data.matchingHostPin;

            const hostRoom = rooms.get(hostPin);

            if (
                hostRoom &&
                hostRoom.hostSocketId === socket.id
            ) {
                closeRoom(
                    hostRoom,
                    "Chủ phòng đã mất kết nối."
                );
            }
        });
    });

    console.log(
        "[MATCHING] Socket handler registered."
    );

    return {
        getRoomStatus() {
            return {
                totalRooms: rooms.size,

                rooms: [...rooms.values()].map(room => ({
                    pin: room.pin,
                    title: room.title,
                    wordSetId: room.wordSetId,
                    players: room.players.size,
                    started: room.started,
                    finished: room.finished,
                })),
            };
        },
    };
};
