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

    // Enhanced pdflatex execution with more detailed logging
    const pdflatex = spawn(
      "pdflatex",
      [
        "-interaction=nonstopmode",
        "-file-line-error", // Adds line numbers to error messages
        baseFilename,
      ],
      {
        cwd: dirPath,
      }
    );

    let stdout = "";
    let stderr = "";

    pdflatex.stdout.on("data", (data) => {
      stdout += data.toString();
      console.log("pdflatex output:", data.toString());
    });

    pdflatex.stderr.on("data", (data) => {
      stderr += data.toString();
      console.error("pdflatex error:", data.toString());
    });

    const exitCode = await new Promise((resolve, reject) => {
      pdflatex.on("close", resolve);
      pdflatex.on("error", reject);
    });

    if (exitCode !== 0) {
      // Parse the log file for more detailed error information
      const logPath = path.join(dirPath, baseFilename.replace(".tex", ".log"));
      let logContent = "";
      try {
        logContent = await fs.readFile(logPath, "utf-8");
      } catch (err) {
        console.error("Could not read log file:", err);
      }

      // Extract relevant error information
      const errorInfo = parseLatexErrors(logContent);

      throw new Error(
        JSON.stringify({
          message: "PDF compilation failed",
          exitCode,
          stdout,
          stderr,
          errors: errorInfo,
          contentPreview: content.substring(0, 200) + "...",
        })
      );
    }

    // Read the generated PDF
    const pdfPath = path.join(dirPath, baseFilename.replace(".tex", ".pdf"));
    const pdfBuffer = await fs.readFile(pdfPath);

    // Clean up files
    const cleanupFiles = [
      baseFilename,
      baseFilename.replace(".tex", ".pdf"),
      baseFilename.replace(".tex", ".aux"),
      baseFilename.replace(".tex", ".log"),
      baseFilename.replace(".tex", ".out"),
    ].map((file) => path.join(dirPath, file));

    // Comment out this cleanup block for debugging
    // await Promise.all(
    //     cleanupFiles.map(file =>
    //         fs.remove(file).catch(err =>
    //             console.error(`Failed to delete ${file}:`, err)
    //         )
    //     )
    // );

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": "attachment",
    });
    res.send(pdfBuffer);
  } catch (error) {
    console.error("Compilation error:", error);

    // Try to parse the error message if it's JSON
    let errorResponse = {
      error: "PDF compilation failed",
      details: error.message,
    };

    try {
      const parsedError = JSON.parse(error.message);
      errorResponse = {
        error: "PDF compilation failed",
        exitCode: parsedError.exitCode,
        details: {
          errors: parsedError.errors,
          stdout: parsedError.stdout,
          stderr: parsedError.stderr,
          contentPreview: parsedError.contentPreview,
        },
      };
    } catch (e) {
      // If parsing fails, use the original error message
    }

    res.status(500).json(errorResponse);
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
