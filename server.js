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

    // Run pdflatex twice to resolve references
    const pdflatexOptions = [
      "-interaction=nonstopmode",
      "-file-line-error",
      // Add -halt-on-error=n to continue despite errors
      "-halt-on-error=n",
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

    await new Promise((resolve) => pdflatex1.on("close", resolve));

    // Second run to resolve references
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

    await new Promise((resolve) => pdflatex2.on("close", resolve));

    // Check if PDF was generated despite errors
    const pdfPath = path.join(dirPath, baseFilename.replace(".tex", ".pdf"));

    try {
      const pdfBuffer = await fs.readFile(pdfPath);

      // Send PDF if it exists, even with compilation warnings
      res.set({
        "Content-Type": "application/pdf",
        "Content-Disposition": "attachment",
      });
      res.send(pdfBuffer);
    } catch (pdfError) {
      // Only throw error if PDF wasn't generated at all
      throw new Error(
        JSON.stringify({
          message: "PDF generation failed completely",
          stdout: stdout1 + stdout2,
          stderr: stderr1 + stderr2,
          contentPreview: content.substring(0, 200) + "...",
        })
      );
    }

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
