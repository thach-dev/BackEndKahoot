
const { supabase } = require("../config/supabase");

// =====================================================
// 1. LẤY BỘ DỮ LIỆU GHÉP ĐÔI CHO HOST
// =====================================================

async function getWordSetForHost(wordSetId) {
    if (!wordSetId) {
        throw new Error("Thiếu mã bộ dữ liệu.");
    }

    const { data: wordSet, error } = await supabase
        .from("word_chain_sets")
        .select(`
            id,
            title,
            description,
            total_words,
            created_at,
            words
        `)
        .eq("id", wordSetId)
        .eq("status", "APPROVED")
        .maybeSingle();

    if (error) {
        console.error("[WORD CHAIN] GET WORD SET ERROR:", error);

        throw new Error(
            `Lỗi truy vấn bộ dữ liệu: ${error.message}`
        );
    }

    if (!wordSet) {
        throw new Error(
            "Không tìm thấy bộ dữ liệu hoặc bộ dữ liệu chưa được duyệt."
        );
    }

    if (!Array.isArray(wordSet.words) || wordSet.words.length === 0) {
        throw new Error(
            "Bộ dữ liệu chưa có nội dung."
        );
    }

    // Giữ lại toàn bộ thuộc tính gốc trong JSONB.
    // Không làm mất question, answer, left_text, right_text...
    const words = wordSet.words
        .map((item, index) => {
            if (typeof item === "string") {
                return {
                    word: item.trim(),
                    normalized_word: item
                        .trim()
                        .normalize("NFC")
                        .toLocaleLowerCase("vi-VN")
                        .replace(/\s+/g, " "),
                    word_order: index + 1,
                };
            }

            if (!item || typeof item !== "object" || Array.isArray(item)) {
                return null;
            }

            const originalWord = String(
                item.word ?? ""
            ).trim();

            const normalizedWord = String(
                item.normalized_word ??
                originalWord
                    .normalize("NFC")
                    .toLocaleLowerCase("vi-VN")
                    .replace(/\s+/g, " ")
            ).trim();

            return {
                ...item,

                word: originalWord,
                normalized_word: normalizedWord,

                word_order: Number(
                    item.word_order ?? index + 1
                ),
            };
        })
        .filter(Boolean)
        .sort((a, b) => a.word_order - b.word_order);

    if (words.length === 0) {
        throw new Error(
            "Không tìm thấy dữ liệu hợp lệ."
        );
    }

    return {
        id: wordSet.id,
        title: wordSet.title,
        description: wordSet.description,
        total_words: words.length,
        created_at: wordSet.created_at,
        words,
    };
}

// =====================================================
// 2. LẤY DANH SÁCH BỘ DỮ LIỆU ĐÃ DUYỆT
// =====================================================

async function getApprovedWordSets() {
    const { data, error } = await supabase
        .from("word_chain_sets")
        .select(`
            id,
            title,
            description,
            total_words,
            created_at
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

        throw new Error(
            `Lỗi lấy danh sách bộ dữ liệu: ${error.message}`
        );
    }

    return data || [];
}

// =====================================================
// 3. TẠO BỘ DỮ LIỆU
// =====================================================

async function createWordSet({
    title,
    description,
    uploaderId,
    words,
}) {
    if (
        !title ||
        !Array.isArray(words) ||
        words.length === 0
    ) {
        throw new Error(
            "Dữ liệu bộ từ không hợp lệ."
        );
    }

    const { data, error } = await supabase
        .from("word_chain_sets")
        .insert({
            title,
            description: description || null,
            uploader_id: uploaderId || null,
            status: "PENDING",
            total_words: words.length,
            words,
        })
        .select()
        .single();

    if (error) {
        console.error(
            "[WORD CHAIN] CREATE WORD SET ERROR:",
            error
        );

        throw new Error(
            `Không thể lưu bộ từ: ${error.message}`
        );
    }

    return data;
}

// =====================================================
// 4. LẤY CHI TIẾT BỘ DỮ LIỆU
// =====================================================

async function getWordSetById(id) {
    const { data, error } = await supabase
        .from("word_chain_sets")
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
            "Không tìm thấy bộ dữ liệu."
        );
    }

    return data;
}

// =====================================================
// 5. XÓA BỘ DỮ LIỆU
// =====================================================

async function deleteWordSet(id) {
    const { error } = await supabase
        .from("word_chain_sets")
        .delete()
        .eq("id", id);

    if (error) {
        console.error(
            "[WORD CHAIN] DELETE WORD SET ERROR:",
            error
        );

        throw new Error(error.message);
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
