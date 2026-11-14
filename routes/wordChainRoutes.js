
const express = require("express");
const multer = require("multer");
const path = require("path");

const requireAdmin = require("../middlewares/adminMiddleware");

const {
    uploadWordSet,
    getWordSets,
    getWordSetDetail,
    removeWordSet,
} = require("../controllers/wordChainController");

const router = express.Router();

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024,
    },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();

        if (![".xlsx", ".xls"].includes(ext)) {
            return cb(new Error("Chỉ chấp nhận file Excel .xlsx hoặc .xls."));
        }

        cb(null, true);
    },
});

router.get("/sets", getWordSets);
router.get("/sets/:id", getWordSetDetail);
router.post("/upload", upload.single("file"), uploadWordSet);
router.delete("/sets/:id", requireAdmin, removeWordSet);

module.exports = router;
