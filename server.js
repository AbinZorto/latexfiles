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

// Add this helper function to format LaTeX output
function formatLatexOutput(stdout) {
  // Split into lines and filter out empty ones
  const lines = stdout.split("\n").filter((line) => line.trim());

  // Group related messages
  const formatted = lines
    .reduce((acc, line) => {
      // Remove common TeX Live paths to reduce noise
      line = line.replace(
        /\/usr\/local\/texlive\/\d+\/texmf-dist\/tex\/[^\s]+\//,
        ""
      );

      // Skip certain verbose lines
      if (
        line.includes("texmf-dist") ||
        line.includes("geometry driver") ||
        line.includes("restricted \\write18 enabled")
      ) {
        return acc;
      }

      // Highlight important messages
      if (line.startsWith("!")) {
        return acc + "\nError: " + line;
      }
      if (line.includes("Warning")) {
        return acc + "\nWarning: " + line;
      }
      if (line.includes("Output written on")) {
        return acc + "\nOutput: " + line;
      }

      return acc + "\n" + line;
    }, "")
    .trim();

  return formatted;
}

app.post("/compile", async (req, res) => {
  try {
    const { content, filename } = req.body;
    const absolutePath = path.resolve("/opt/latexfiles", filename);
    const dirPath = path.dirname(absolutePath);
    const baseFilename = path.basename(filename);

    await fs.mkdirp(dirPath);
    await fs.writeFile(absolutePath, content, "utf-8");

    // Run pdflatex twice
    for (let i = 0; i < 2; i++) {
      const pdflatex = spawn(
        "pdflatex",
        [
          "-file-line-error",
          "-interaction=nonstopmode",
          "-halt-on-error=n",
          baseFilename,
        ],
        { cwd: dirPath }
      );

      let stdout = "";
      let stderr = "";

      pdflatex.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      pdflatex.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      await new Promise((resolve) => pdflatex.on("close", resolve));
    }

    // Check if PDF was generated, regardless of exit code
    const pdfPath = path.join(dirPath, baseFilename.replace(".tex", ".pdf"));

    try {
      const pdfBuffer = await fs.readFile(pdfPath);
      if (pdfBuffer.length > 0) {
        // PDF exists and has content
        return res.status(200).json({
          success: true,
          pdf: pdfBuffer.toString("base64"),
          output: formatLatexOutput(stdout),
          warnings: true,
        });
      }
    } catch (pdfError) {
      throw new Error("Failed to generate PDF");
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
const parseLatexErrors = (logContent) => {
  const errors = [];
  let match;

  // Parse LaTeX errors
  const errorRegex = /^(?:.|[\r\n])*?(?:!\s.*\n|.*?:\d+:\s.*\n)/gm;
  while ((match = errorRegex.exec(logContent)) !== null) {
    const errorText = match[0].trim();
    const lineMatch = errorText.match(/:(\d+):/);
    errors.push({
      type: "Error",
      line: lineMatch ? parseInt(lineMatch[1], 10) : null,
      details: errorText.replace(/^!?\s*/, ""),
      context: match[0],
    });
  }

  // Parse LaTeX warnings
  const warningRegex =
    /LaTeX Warning:(.*?)(?:\son\sline\s(\d+)|(?=\n\n|\n[^\\]))/gs;
  while ((match = warningRegex.exec(logContent)) !== null) {
    errors.push({
      type: "Warning",
      line: match[2] ? parseInt(match[2], 10) : null,
      details: match[1].trim().replace(/\n\s*/g, " "),
      context: match[0],
    });
  }

  return errors;
};

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => console.log(`LaTeX service running on port ${PORT}`));
