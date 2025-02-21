require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const fs = require("fs-extra");
const path = require("path");

const app = express();
app.use(
  cors({
    exposedHeaders: ["X-LaTeX-Output"],
  })
);
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
    const { content, filename, bibliography } = req.body;

    const absolutePath = path.resolve("/opt/latexfiles", filename);
    const dirPath = path.dirname(absolutePath);
    const baseFilename = path.basename(filename);
    console.log("absolutePath", absolutePath);
    console.log("dirPath", dirPath);
    console.log("baseFilename", baseFilename);

    // Create directory and write main LaTeX file
    await fs.mkdirp(dirPath);
    await fs.writeFile(absolutePath, content, "utf-8");

    // Write bibliography file if provided
    if (bibliography?.content) {
      const bibPath = path.join(dirPath, bibliography.filename);
      console.log("Writing bibliography to:", bibPath);
      await fs.writeFile(bibPath, bibliography.content, "utf-8");
    }

    const pdflatexOptions = [
      "-file-line-error",
      "-interaction=nonstopmode",
      "-halt-on-error=n",
      baseFilename,
    ];

    // First pdflatex run
    const pdflatex1 = spawn("pdflatex", pdflatexOptions, { cwd: dirPath });
    let stdout1 = "";
    let stderr1 = "";

    pdflatex1.stdout.on("data", (data) => {
      stdout1 += data.toString();
    });

    pdflatex1.stderr.on("data", (data) => {
      stderr1 += data.toString();
    });

    await new Promise((resolve) => pdflatex1.on("close", resolve));

    // Run bibtex if bibliography was provided
    let bibtexOutput = "";
    if (bibliography?.content) {
      const bibtex = spawn("bibtex", [baseFilename.replace(".tex", "")], {
        cwd: dirPath,
      });
      let bibtexStdout = "";
      let bibtexStderr = "";

      bibtex.stdout.on("data", (data) => {
        bibtexStdout += data.toString();
      });

      bibtex.stderr.on("data", (data) => {
        bibtexStderr += data.toString();
      });

      await new Promise((resolve) => bibtex.on("close", resolve));
      bibtexOutput = bibtexStdout + bibtexStderr;
    }

    // Second pdflatex run
    const pdflatex2 = spawn("pdflatex", pdflatexOptions, { cwd: dirPath });
    let stdout2 = "";
    let stderr2 = "";

    pdflatex2.stdout.on("data", (data) => {
      stdout2 += data.toString();
    });

    pdflatex2.stderr.on("data", (data) => {
      stderr2 += data.toString();
    });

    await new Promise((resolve) => pdflatex2.on("close", resolve));

    // Third pdflatex run (needed for references)
    const pdflatex3 = spawn("pdflatex", pdflatexOptions, { cwd: dirPath });
    let stdout3 = "";
    let stderr3 = "";

    pdflatex3.stdout.on("data", (data) => {
      stdout3 += data.toString();
    });

    pdflatex3.stderr.on("data", (data) => {
      stderr3 += data.toString();
    });

    await new Promise((resolve) => pdflatex3.on("close", resolve));

    // Check if PDF exists and try to read it
    const pdfPath = path.join(dirPath, baseFilename.replace(".tex", ".pdf"));

    try {
      const pdfBuffer = await fs.readFile(pdfPath);
      const pdfBase64 = pdfBuffer.toString("base64");

      // Extract any errors/warnings from the output
      const logPath = path.join(dirPath, baseFilename.replace(".tex", ".log"));
      const logContent = await fs.readFile(logPath, "utf-8");
      const errors = parseLatexErrors(logContent);

      // Also check for BibTeX-specific errors
      if (bibliography?.content) {
        const blgPath = path.join(
          dirPath,
          baseFilename.replace(".tex", ".blg")
        );
        try {
          const blgContent = await fs.readFile(blgPath, "utf-8");
          const bibErrors = parseBibTeXErrors(blgContent);
          errors.push(...bibErrors);
        } catch (blgError) {
          console.warn("Could not read BibTeX log file:", blgError);
        }
      }

      // If we have a PDF, return it along with any warnings
      return res.status(200).json({
        success: true,
        pdf: pdfBase64,
        output: formatLatexOutput(stdout1 + bibtexOutput + stdout2 + stdout3),
        errors: errors,
        warnings: errors.length > 0,
      });
    } catch (pdfError) {
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

// Add this function to parse BibTeX-specific errors
const parseBibTeXErrors = (blgContent) => {
  const errors = [];
  const lines = blgContent.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Look for warning and error messages
    if (line.includes("Warning--") || line.startsWith("I was expecting")) {
      errors.push({
        type: "Warning",
        line: null,
        details: line.trim(),
        context: line,
      });
    } else if (line.includes("error")) {
      errors.push({
        type: "Error",
        line: null,
        details: line.trim(),
        context: line,
      });
    }
  }

  return errors;
};

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => console.log(`LaTeX service running on port ${PORT}`));
