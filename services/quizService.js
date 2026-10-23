
const { supabase } = require("../config/supabase");

async function getQuizForHost(quizId, ownerId) {
  if (!quizId || !ownerId) {
    throw new Error("Thiếu quizId hoặc ownerId.");
  }

  // 1. Lấy quiz và kiểm tra quyền sở hữu
  const { data: quiz, error: quizError } = await supabase
    .from("quiz_games")
    .select("id, owner_id, title, created_at")
    .eq("id", quizId)
    .eq("owner_id", ownerId)
    .maybeSingle();

  if (quizError) {
    console.error("GET QUIZ ERROR:", quizError);
    throw new Error(`Lỗi truy vấn quiz: ${quizError.message}`);
  }

  if (!quiz) {
    throw new Error(
      "Không tìm thấy bài quiz hoặc tài khoản hiện tại không sở hữu bài quiz này."
    );
  }

  // 2. Lấy câu hỏi từ đúng bảng quiz_questions
  const { data: questions, error: questionsError } = await supabase
    .from("quiz_questions")
    .select("*")
    .eq("game_id", quizId)
    .order("question_order", { ascending: true });

  if (questionsError) {
    console.error("GET QUESTIONS ERROR:", questionsError);
    throw new Error(`Không thể lấy câu hỏi: ${questionsError.message}`);
  }

  if (!questions || questions.length === 0) {
    throw new Error("Bài quiz này chưa có câu hỏi.");
  }

  // 3. Chuẩn hóa câu hỏi cho Socket.IO
  return {
    ...quiz,
    questions: questions.map((q) => ({
      ...q,
      question_text: q.question_text,
      answers: q.answers,
      correct_answer: q.correct_answer,
      time_limit: q.time_limit ?? 20,
      points: q.points ?? 1000,
    })),
  };
}

module.exports = { getQuizForHost };
