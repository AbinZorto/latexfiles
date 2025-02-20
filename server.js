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

    // Run pdflatex twice as before
    const pdflatex1 = spawn(
      "pdflatex",
      [
        "-file-line-error",
        "-interaction=nonstopmode",
        "-halt-on-error=n",
        baseFilename,
      ],
      { cwd: dirPath }
    );

    let stdout1 = "";
    pdflatex1.stdout.on("data", (data) => (stdout1 += data.toString()));
    await new Promise((resolve) => pdflatex1.on("close", resolve));

    const pdflatex2 = spawn(
      "pdflatex",
      [
        "-file-line-error",
        "-interaction=nonstopmode",
        "-halt-on-error=n",
        baseFilename,
      ],
      { cwd: dirPath }
    );

    let stdout2 = "";
    pdflatex2.stdout.on("data", (data) => (stdout2 += data.toString()));
    await new Promise((resolve) => pdflatex2.on("close", resolve));

    // Check for PDF regardless of exit code
    // Instead of checking process exit code, look for PDF
    const pdfPath = path.join(dirPath, baseFilename.replace(".tex", ".pdf"));

    if (await fs.pathExists(pdfPath)) {
      const pdfBuffer = await fs.readFile(pdfPath);
      // PDF was generated, return it despite warnings
      return res.status(200).json({
        success: true,
        pdf: pdfBuffer.toString("base64"),
        output: formatLatexOutput(stdout1 + stdout2), // Use both stdout captures
        warnings: true,
      });
    }

    // Only error if no PDF was generated
    throw new Error("No PDF was generated");
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
