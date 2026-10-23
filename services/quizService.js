
const { supabase } = require("../config/supabase");

/**
 * Lấy bài quiz để host tạo phòng.
 * Chỉ chủ sở hữu bài quiz mới được phép mở phòng.
 */
async function getQuizForHost(quizId, ownerId) {
  if (!quizId || !ownerId) {
    throw new Error("Thiếu quizId hoặc ownerId.");
  }

  const { data: quiz, error: quizError } = await supabase
    .from("quizzes")
    .select("*")
    .eq("id", quizId)
    .eq("owner_id", ownerId)
    .single();

  if (quizError || !quiz) {
    throw new Error("Không tìm thấy bài quiz hoặc bạn không có quyền truy cập.");
  }

  const { data: questions, error: questionsError } = await supabase
    .from("questions")
    .select("*")
    .eq("quiz_id", quizId)
    .order("created_at", { ascending: true });

  if (questionsError) {
    throw new Error(`Không thể lấy câu hỏi: ${questionsError.message}`);
  }

  return {
    ...quiz,
    questions: (questions || []).map((q) => ({
      ...q,
      question_text: q.question_text,
      answers: q.answers,
      correct_answer: q.correct_answer,
      time_limit: q.time_limit ?? 20,
      points: q.points ?? 100,
    })),
  };
}

module.exports = {
  getQuizForHost,
};