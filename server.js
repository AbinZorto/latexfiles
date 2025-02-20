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

    // Second run
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

    // Check if PDF was generated
    const pdfPath = path.join(dirPath, baseFilename.replace(".tex", ".pdf"));

    try {
      const pdfBuffer = await fs.readFile(pdfPath);
      const pdfBase64 = pdfBuffer.toString("base64");

      // Always return success if we have a PDF, even with warnings
      return res.status(200).json({
        pdf: pdfBase64,
        output: formatLatexOutput(stdout1 + stdout2),
        warnings: true,
      });
    } catch (pdfError) {
      // Only throw if we couldn't read the PDF
      console.error("Failed to read PDF:", pdfError);
      throw new Error("No PDF was generated");
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
  // Match LaTeX errors more comprehensively
  const errorRegex =
    /!(.*?)(?:\nl\.|line\s)(\d+)(?:\s|\.)(.*?)(?=\n\n|\n!|$)/gs;

  let match;
  while ((match = errorRegex.exec(logContent)) !== null) {
    errors.push({
      type: match[1].trim(),
      line: parseInt(match[2], 10),
      details: match[3].trim().replace(/\n\s*/g, " "), // Clean up multi-line errors
      context: match[0], // Include full error context
    });
  }

  // Also catch warnings
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
}

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => console.log(`LaTeX service running on port ${PORT}`));
