
const { supabase } = require("../config/supabase");

const TABLE_NAME = "word_chain_sets";

// =====================================================
// 1. CHUẨN HÓA DỮ LIỆU GHÉP ĐÔI
// =====================================================

function normalizeMatchingData(gameData) {
    if (
        !gameData ||
        typeof gameData !== "object" ||
        Array.isArray(gameData) ||
        gameData.game_type !== "MATCHING"
    ) {
        throw new Error("Dữ liệu game ghép đôi không hợp lệ.");
    }

    if (
        !Array.isArray(gameData.questions) ||
        !gameData.questions.length
    ) {
        throw new Error("Bộ dữ liệu chưa có câu hỏi ghép đôi.");
    }

    if (
        !Array.isArray(gameData.options) ||
        !gameData.options.length
    ) {
        throw new Error("Bộ dữ liệu chưa có phương án ghép đôi.");
    }

    const optionKeys = new Set();

    const options = gameData.options.map((item, index) => {
        const optionKey = String(item?.option_key ?? "")
            .trim()
            .toUpperCase();

        const rightText = String(item?.right_text ?? "")
            .normalize("NFC")
            .trim()
            .replace(/\s+/g, " ");

        if (!optionKey || !rightText) {
            throw new Error(
                `Phương án thứ ${index + 1} không hợp lệ.`
            );
        }

        if (!/^[A-Z0-9]+$/.test(optionKey)) {
            throw new Error(
                `Mã phương án ${optionKey} không hợp lệ.`
            );
        }

        if (optionKeys.has(optionKey)) {
            throw new Error(
                `Mã phương án ${optionKey} bị trùng.`
            );
        }

        optionKeys.add(optionKey);

        return {
            option_key: optionKey,
            right_text: rightText,
        };
    });

    const questionIds = new Set();

    const questions = gameData.questions.map((item, index) => {
        const id = item?.id ?? index + 1;

        const leftText = String(item?.left_text ?? "")
            .normalize("NFC")
            .trim()
            .replace(/\s+/g, " ");

        const correctKey = String(
            item?.correct_option_key ?? ""
        )
            .trim()
            .toUpperCase();

        if (!leftText || !correctKey) {
            throw new Error(
                `Câu hỏi thứ ${index + 1} thiếu nội dung hoặc đáp án.`
            );
        }

        if (questionIds.has(String(id))) {
            throw new Error(`ID câu hỏi ${id} bị trùng.`);
        }

        if (
            correctKey !== "0" &&
            !optionKeys.has(correctKey)
        ) {
            throw new Error(
                `Câu hỏi ${id} có đáp án ${correctKey} không tồn tại.`
            );
        }

        questionIds.add(String(id));

        return {
            id,
            left_text: leftText,
            correct_option_key: correctKey,
        };
    });

    return {
        game_type: "MATCHING",
        questions,
        options,
        total_questions: questions.length,
        total_options: options.length,
    };
}

// =====================================================
// 2. CHUẨN HÓA DỮ LIỆU NỐI TỪ CŨ
// =====================================================

function normalizeWordChainData(words) {
    if (!Array.isArray(words) || !words.length) {
        throw new Error("Bộ dữ liệu chưa có nội dung.");
    }

    return words
        .map((item, index) => {
            if (typeof item === "string") {
                const word = item.trim();

                return {
                    word,
                    normalized_word: word
                        .normalize("NFC")
                        .toLocaleLowerCase("vi-VN")
                        .replace(/\s+/g, " "),
                    word_order: index + 1,
                };
            }

            if (
                !item ||
                typeof item !== "object" ||
                Array.isArray(item)
            ) {
                return null;
            }

            const word = String(item.word ?? "")
                .normalize("NFC")
                .trim()
                .replace(/\s+/g, " ");

            if (!word) return null;

            return {
                ...item,
                word,
                normalized_word: String(
                    item.normalized_word ??
                    word
                        .normalize("NFC")
                        .toLocaleLowerCase("vi-VN")
                        .replace(/\s+/g, " ")
                ),
                word_order: Number(item.word_order ?? index + 1),
            };
        })
        .filter(Boolean)
        .sort((a, b) => a.word_order - b.word_order);
}

// =====================================================
// 3. LẤY CHI TIẾT BỘ DỮ LIỆU
// =====================================================

async function getWordSetById(id) {
    if (!id) {
        throw new Error("Thiếu ID bộ dữ liệu.");
    }

    const { data, error } = await supabase
        .from(TABLE_NAME)
        .select("*")
        .eq("id", id)
        .eq("status", "APPROVED")
        .maybeSingle();

    if (error) {
        console.error(
            "[WORD CHAIN] GET WORD SET DETAIL ERROR:",
            error
        );

        throw new Error(error.message);
    }

    if (!data) {
        throw new Error(
            "Không tìm thấy bộ dữ liệu hoặc bộ dữ liệu chưa được duyệt."
        );
    }

    return data;
}

// =====================================================
// 4. LẤY DỮ LIỆU CHO HOST TẠO PHÒNG
// Hỗ trợ cả MATCHING và WORD_CHAIN
// =====================================================

async function getWordSetForHost(wordSetId) {
    console.log(
        "[WORD CHAIN] GET WORD SET FOR HOST:",
        wordSetId
    );

    const data = await getWordSetById(wordSetId);

    console.log(
        "[WORD CHAIN] WORD SET LOADED:",
        {
            id: data.id,
            title: data.title,
            status: data.status,
            wordsType: Array.isArray(data.words)
                ? "ARRAY"
                : typeof data.words,
            gameType: data.words?.game_type,
        }
    );

    // -----------------------------------------------
    // MATCHING: JSONB object
    // -----------------------------------------------

    if (
        data.words &&
        !Array.isArray(data.words) &&
        data.words.game_type === "MATCHING"
    ) {
        const matchingData = normalizeMatchingData(data.words);

        console.log(
            "[MATCHING] DATA READY:",
            {
                totalQuestions: matchingData.total_questions,
                totalOptions: matchingData.total_options,
            }
        );

        return {
            id: data.id,
            title: data.title,
            description: data.description,
            game_type: "MATCHING",
            total_questions: matchingData.total_questions,
            total_options: matchingData.total_options,
            questions: matchingData.questions,
            options: matchingData.options,
        };
    }

    // -----------------------------------------------
    // WORD_CHAIN: mảng dữ liệu cũ
    // -----------------------------------------------

    if (Array.isArray(data.words)) {
        const words = normalizeWordChainData(data.words);

        if (!words.length) {
            throw new Error("Không tìm thấy dữ liệu nối từ hợp lệ.");
        }

        return {
            id: data.id,
            title: data.title,
            description: data.description,
            game_type: "WORD_CHAIN",
            total_words: words.length,
            words,
        };
    }

    throw new Error(
        "Bộ dữ liệu không đúng định dạng MATCHING hoặc WORD_CHAIN."
    );
}

// =====================================================
// 5. LẤY DANH SÁCH BỘ DỮ LIỆU ĐÃ DUYỆT
// =====================================================

async function getApprovedWordSets() {
    const { data, error } = await supabase
        .from(TABLE_NAME)
        .select(`
            id,
            title,
            description,
            total_words,
            status,
            created_at,
            words
        `)
        .eq("status", "APPROVED")
        .order("created_at", {
            ascending: false,
        });

    if (error) {
        console.error(
            "[WORD CHAIN] GET APPROVED SETS ERROR:",
            error
        );

        throw new Error(error.message);
    }

    return (data || []).map((item) => {
        const isMatching =
            item.words &&
            !Array.isArray(item.words) &&
            item.words.game_type === "MATCHING";

        return {
            id: item.id,
            title: item.title,
            description: item.description,
            status: item.status,
            created_at: item.created_at,
            game_type: isMatching
                ? "MATCHING"
                : "WORD_CHAIN",
            total_words: item.total_words,
            total_questions: isMatching
                ? item.words.questions?.length || 0
                : undefined,
            total_options: isMatching
                ? item.words.options?.length || 0
                : undefined,
        };
    });
}

// =====================================================
// 6. TẠO BỘ DỮ LIỆU
// Hàm này giữ tương thích nếu Render có chức năng tạo
// dữ liệu riêng. Upload hiện tại thực hiện ở VERCEL.
// =====================================================

async function createWordSet({
    title,
    description,
    uploaderId,
    words,
    gameData,
}) {
    let storedData;
    let totalWords;
    let gameType;

    if (gameData?.game_type === "MATCHING") {
        storedData = normalizeMatchingData(gameData);
        totalWords = storedData.total_questions;
        gameType = "MATCHING";
    } else {
        if (!Array.isArray(words) || !words.length) {
            throw new Error("Dữ liệu bộ từ không hợp lệ.");
        }

        storedData = words;
        totalWords = words.length;
        gameType = "WORD_CHAIN";
    }

    const { data, error } = await supabase
        .from(TABLE_NAME)
        .insert({
            title,
            description: description || null,
            uploader_id: uploaderId || null,
            status: "APPROVED",
            total_words: totalWords,
            words: storedData,
        })
        .select()
        .single();

    if (error) {
        console.error(
            "[WORD CHAIN] CREATE WORD SET ERROR:",
            error
        );

        throw new Error(error.message);
    }

    return {
        ...data,
        game_type: gameType,
    };
}

// =====================================================
// 7. XÓA BỘ DỮ LIỆU
// =====================================================

async function deleteWordSet(id) {
    if (!id) {
        throw new Error("Thiếu ID bộ dữ liệu cần xóa.");
    }

    const { data, error } = await supabase
        .from(TABLE_NAME)
        .delete()
        .eq("id", id)
        .select("id")
        .maybeSingle();

    if (error) {
        console.error(
            "[WORD CHAIN] DELETE WORD SET ERROR:",
            error
        );

        throw new Error(error.message);
    }

    if (!data) {
        throw new Error(
            "Bộ dữ liệu không tồn tại hoặc không thể xóa."
        );
    }

    return true;
}

// =====================================================
// EXPORT
// =====================================================

module.exports = {
    getWordSetForHost,
    getApprovedWordSets,
    createWordSet,
    getWordSetById,
    deleteWordSet,
};
