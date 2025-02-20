require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const fs = require("fs-extra");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

// API Key Authentication
const authenticateApiKey = (req, res, next) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== process.env.LATEX_SERVICE_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
};

app.use(authenticateApiKey);

app.post("/compile", async (req, res) => {
  try {
    const { content, filename } = req.body;

    if (!filename || typeof filename !== "string") {
      return res.status(400).json({
        error: "Invalid filename",
        details: `Received: ${typeof filename}`,
      });
    }

    if (!content || typeof content !== "string") {
      return res.status(400).json({
        error: "Invalid content",
        details: `Received: ${typeof content}`,
      });
    }

    const absolutePath = path.resolve("/opt/latexfiles", filename);
    const dirPath = path.dirname(absolutePath);
    const baseFilename = path.basename(filename);

    // Create directory if it doesn't exist
    await fs.mkdirp(dirPath);

    // Write the LaTeX content and log it
    await fs.writeFile(absolutePath, content, "utf-8");
    console.log(`LaTeX file written to: ${absolutePath}`);
    console.log("Content preview:", content.substring(0, 200) + "...");

    // Run pdflatex with more permissive options
    const pdflatexOptions = [
      "-interaction=nonstopmode",
      "-file-line-error",
      "-halt-on-error=n",
      "-shell-escape", // Add this to allow external commands
      baseFilename,
    ];

    // First run
    const pdflatex1 = spawn("pdflatex", pdflatexOptions, { cwd: dirPath });
    let stdout1 = "";
    let stderr1 = "";

    pdflatex1.stdout.on("data", (data) => {
      stdout1 += data.toString();
      console.log("pdflatex output:", data.toString());
    });

    pdflatex1.stderr.on("data", (data) => {
      stderr1 += data.toString();
      console.error("pdflatex error:", data.toString());
    });

    await new Promise((resolve, reject) => {
      pdflatex1.on("close", (code) => {
        // Don't reject on non-zero exit code
        resolve();
      });
    });

    // Second run with same permissive handling
    const pdflatex2 = spawn("pdflatex", pdflatexOptions, { cwd: dirPath });
    let stdout2 = "";
    let stderr2 = "";

    pdflatex2.stdout.on("data", (data) => {
      stdout2 += data.toString();
      console.log("pdflatex output:", data.toString());
    });

    pdflatex2.stderr.on("data", (data) => {
      stderr2 += data.toString();
      console.error("pdflatex error:", data.toString());
    });

    await new Promise((resolve, reject) => {
      pdflatex2.on("close", (code) => {
        // Don't reject on non-zero exit code
        resolve();
      });
    });

    // Check if PDF exists and try to send it
    const pdfPath = path.join(dirPath, baseFilename.replace(".tex", ".pdf"));

    try {
      const pdfBuffer = await fs.readFile(pdfPath);

      // Send PDF if it exists, regardless of compilation warnings/errors
      res.set({
        "Content-Type": "application/pdf",
        "Content-Disposition": "attachment",
      });
      res.send(pdfBuffer);

      // Cleanup after successful send
      const cleanupFiles = [
        baseFilename,
        baseFilename.replace(".tex", ".pdf"),
        baseFilename.replace(".tex", ".aux"),
        baseFilename.replace(".tex", ".log"),
        baseFilename.replace(".tex", ".out"),
      ].map((file) => path.join(dirPath, file));

      // Optional cleanup
      await Promise.all(
        cleanupFiles.map((file) =>
          fs
            .remove(file)
            .catch((err) => console.error(`Failed to delete ${file}:`, err))
        )
      );
    } catch (pdfError) {
      // Only throw error if PDF wasn't generated at all
      throw new Error(
        JSON.stringify({
          message: "PDF generation failed completely - no output file created",
          stdout: stdout1 + stdout2,
          stderr: stderr1 + stderr2,
          contentPreview: content.substring(0, 200) + "...",
        })
      );
    }
  } catch (error) {
    console.error("Compilation error:", error);
    res.status(500).json({
      error: "PDF compilation failed",
      details: error.message,
    });
  }
});

// Helper function to parse LaTeX errors from log file
function parseLatexErrors(logContent) {
  const errors = [];
  const errorRegex = /!(.*?)\nl\.(\d+)(.*?)(?=\n\n|\n!|$)/gs;

  let match;
  while ((match = errorRegex.exec(logContent)) !== null) {
    errors.push({
      type: match[1].trim(),
      line: match[2],
      details: match[3].trim(),
    });
  }

  return errors;
}

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => console.log(`LaTeX service running on port ${PORT}`));
