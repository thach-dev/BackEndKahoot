
const { supabase } = require("../config/supabase");

// =====================================================
// 1. LẤY BỘ TỪ CHO HOST
// Tương tự getQuizForHost() bên Game Quiz
// =====================================================

async function getWordSetForHost(wordSetId) {
    if (!wordSetId) {
        throw new Error("Thiếu mã bộ từ.");
    }

    // Lấy bộ từ từ bảng word_chain_sets
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
        console.error("GET WORD SET ERROR:", error);
        throw new Error(`Lỗi truy vấn bộ từ: ${error.message}`);
    }

    if (!wordSet) {
        throw new Error("Không tìm thấy bộ từ hoặc bộ từ chưa được duyệt.");
    }

    // Kiểm tra JSONB
    if (!Array.isArray(wordSet.words) || wordSet.words.length === 0) {
        throw new Error("Bộ từ này chưa có dữ liệu từ vựng.");
    }

    // Chuẩn hóa từ vựng
    const words = wordSet.words
        .map((item, index) => {
            const originalWord =
                typeof item === "string"
                    ? item
                    : item.word ?? "";

            const normalizedWord =
                typeof item === "string"
                    ? item.trim().toLowerCase().replace(/\s+/g, " ")
                    : item.normalized_word ??
                      originalWord.trim().toLowerCase().replace(/\s+/g, " ");

            return {
                word: originalWord.trim(),
                normalized_word: normalizedWord,
                word_order:
                    typeof item === "object" && item.word_order
                        ? item.word_order
                        : index + 1,
            };
        })
        .filter(item => item.word && item.normalized_word)
        .sort((a, b) => a.word_order - b.word_order);

    if (words.length === 0) {
        throw new Error("Không tìm thấy từ vựng hợp lệ trong bộ từ.");
    }

    // Trả dữ liệu cho Host / Socket.IO
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
// 2. LẤY DANH SÁCH BỘ TỪ ĐÃ ĐƯỢC DUYỆT
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
        .order("created_at", { ascending: false });

    if (error) {
        console.error("GET APPROVED WORD SETS ERROR:", error);
        throw new Error(`Lỗi lấy danh sách bộ từ: ${error.message}`);
    }

    return data || [];
}


// =====================================================
// 3. TẠO BỘ TỪ
// Một bộ từ = một dòng JSONB
// =====================================================

async function createWordSet({
    title,
    description,
    uploaderId,
    words,
}) {
    if (!title || !Array.isArray(words) || words.length === 0) {
        throw new Error("Dữ liệu bộ từ không hợp lệ.");
    }

    const { data, error } = await supabase
        .from("word_chain_sets")
        .insert({
            title,
            description: description || null,
            uploader_id: uploaderId || null,

            // Chờ quản trị viên duyệt
            status: "PENDING",

            total_words: words.length,
            words,
        })
        .select()
        .single();

    if (error) {
        console.error("CREATE WORD SET ERROR:", error);
        throw new Error(`Không thể lưu bộ từ: ${error.message}`);
    }

    return data;
}


// =====================================================
// 4. LẤY CHI TIẾT BỘ TỪ
// =====================================================

async function getWordSetById(id) {
    const { data, error } = await supabase
        .from("word_chain_sets")
        .select("*")
        .eq("id", id)
        .eq("status", "APPROVED")
        .maybeSingle();

    if (error) {
        console.error("GET WORD SET DETAIL ERROR:", error);
        throw new Error(error.message);
    }

    if (!data) {
        throw new Error("Không tìm thấy bộ từ.");
    }

    return data;
}


// =====================================================
// 5. XÓA BỘ TỪ
// =====================================================

async function deleteWordSet(id) {
    const { error } = await supabase
        .from("word_chain_sets")
        .delete()
        .eq("id", id);

    if (error) {
        console.error("DELETE WORD SET ERROR:", error);
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
