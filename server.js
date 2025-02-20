require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const fs = require("fs-extra");
const path = require("path");
const os = require("os");

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

    // Don't check exit code, just wait for process to finish
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

    pdflatex2.stdout.on("data", (data) => {
      fullOutput += data.toString();
    });
    pdflatex2.stderr.on("data", (data) => {
      fullOutput += data.toString();
    });

    // Wait for second compilation
    await new Promise((resolve) => pdflatex2.on("close", resolve));

    // Try to read and send PDF regardless of compilation warnings
    try {
      const pdfBuffer = await fs.readFile(absolutePath);
      res.set({
        "Content-Type": "application/pdf",
        "Content-Disposition": "attachment",
      });
      res.send(pdfBuffer);
    } catch (pdfError) {
      // Only if PDF wasn't generated at all
      let logContent = "";
      try {
        logContent = await fs.readFile(logFilePath, "utf-8");
      } catch (logError) {
        console.error("Error reading log file:", logError);
      }

      const errorDetails = {
        fullOutput,
        logContent,
        compilationOutput: fullOutput
          .split("\n")
          .filter(
            (line) =>
              line.includes("!") ||
              line.includes("Error") ||
              line.includes("Fatal")
          )
          .join("\n"),
      };

      return res.status(500).json({
        statusCode: 500,
        error: "LaTeX Compilation Failed",
        details: {
          mainError: extractMainError(logContent || fullOutput),
          location: extractErrorLocation(logContent || fullOutput),
          message: extractErrorMessage(logContent || fullOutput),
          fullError: errorDetails,
        },
      });
    }
  } catch (error) {
    console.error("Server error:", error);
    res.status(500).json({
      statusCode: 500,
      error: "Server Error",
      message: error.message,
    });
  } finally {
    // Clean up temporary directory
    if (uniqueTmpDir) {
      await fs.remove(uniqueTmpDir).catch(console.error);
    }
  }
});

// Error Extraction Utilities
function extractMainError(output) {
  const errorMatch = output.match(/(?:!|Error:).*$/m);
  return errorMatch ? errorMatch[0].trim() : "Unknown error";
}

function extractErrorLocation(output) {
  const lineMatch = output.match(/l\.(\d+)/);
  return lineMatch ? `Line ${lineMatch[1]}` : "Unknown location";
}

function extractErrorMessage(output) {
  const lines = output.split("\n");
  const errorIndex = lines.findIndex(
    (line) => line.includes("!") || line.includes("Error:")
  );
  if (errorIndex === -1) return "Unknown error message";

  return lines
    .slice(errorIndex, errorIndex + 3)
    .map((line) => line.trim())
    .filter((line) => line)
    .join(" ");
}

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => console.log(`LaTeX service running on port ${PORT}`));
