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
  // Initialize stdout variables at the top level so they're available in catch blocks
  let stdout1 = "",
    stdout2 = "",
    stdout3 = "";

  try {
    const { content, filename, bibliography } = req.body;
    console.log("Compile request received:", {
      filenameReceived: filename,
      contentLength: content?.length,
      hasBibliography: !!bibliography,
    });

    // Input validation checks
    if (!content || !filename) {
      console.error("Missing required fields:", {
        content: !!content,
        filename: !!filename,
      });
      return res.status(400).json({ error: "Missing required fields" });
    }

    const absolutePath = path.resolve("/opt/latexfiles", filename);
    const dirPath = path.dirname(absolutePath);
    const baseFilename = path.basename(filename);
    console.log("File paths:", {
      absolutePath,
      dirPath,
      baseFilename,
    });

    try {
      await fs.mkdirp(dirPath);
      await fs.writeFile(absolutePath, content, "utf-8");
      console.log("LaTeX file written successfully");

      if (bibliography?.content) {
        const bibPath = path.join(dirPath, "references.bib");
        await fs.writeFile(bibPath, bibliography.content, "utf-8");
        console.log("Bibliography file written successfully");
      }

      const pdflatexOptions = [
        "-file-line-error",
        "-interaction=nonstopmode",
        baseFilename,
      ];
      console.log("pdflatex options:", pdflatexOptions);

      // First pdflatex run
      console.log("Starting first pdflatex run...");
      const pdflatex1 = spawn("pdflatex", pdflatexOptions, { cwd: dirPath });
      let stderr1 = "";

      pdflatex1.stdout.on("data", (data) => {
        stdout1 += data.toString();
      });

      pdflatex1.stderr.on("data", (data) => {
        stderr1 += data.toString();
        console.error("pdflatex1 stderr:", data.toString());
      });

      await new Promise((resolve) =>
        pdflatex1.on("close", (code) => {
          console.log("First pdflatex run completed with code:", code);
          resolve();
        })
      );

      // Run bibtex if bibliography exists
      let bibtexOutput = "";
      if (bibliography?.content) {
        console.log("Starting bibtex run...");
        const bibtex = spawn("bibtex", [baseFilename.replace(".tex", "")], {
          cwd: dirPath,
        });

        bibtex.stdout.on("data", (data) => {
          bibtexOutput += data.toString();
        });

        bibtex.stderr.on("data", (data) => {
          console.error("bibtex stderr:", data.toString());
        });

        await new Promise((resolve) =>
          bibtex.on("close", (code) => {
            console.log("BibTeX run completed with code:", code);
            resolve();
          })
        );
      }

      // Second pdflatex run
      console.log("Starting second pdflatex run...");
      const pdflatex2 = spawn("pdflatex", pdflatexOptions, { cwd: dirPath });
      let stderr2 = "";

      pdflatex2.stdout.on("data", (data) => {
        stdout2 += data.toString();
      });

      pdflatex2.stderr.on("data", (data) => {
        stderr2 += data.toString();
        console.error("pdflatex2 stderr:", data.toString());
      });

      await new Promise((resolve) =>
        pdflatex2.on("close", (code) => {
          console.log("Second pdflatex run completed with code:", code);
          resolve();
        })
      );

      // Third pdflatex run
      console.log("Starting third pdflatex run...");
      const pdflatex3 = spawn("pdflatex", pdflatexOptions, { cwd: dirPath });
      let stderr3 = "";

      pdflatex3.stdout.on("data", (data) => {
        stdout3 += data.toString();
      });

      pdflatex3.stderr.on("data", (data) => {
        stderr3 += data.toString();
        console.error("pdflatex3 stderr:", data.toString());
      });

      await new Promise((resolve) =>
        pdflatex3.on("close", (code) => {
          console.log("Third pdflatex run completed with code:", code);
          resolve();
        })
      );

      // Check if PDF exists and try to read it
      const pdfPath = path.join(dirPath, baseFilename.replace(".tex", ".pdf"));
      console.log("Attempting to read PDF from:", pdfPath);

      try {
        const pdfBuffer = await fs.readFile(pdfPath);
        console.log("PDF file read successfully, size:", pdfBuffer.length);
        const pdfBase64 = pdfBuffer.toString("base64");

        // Extract any errors/warnings from the output
        const logPath = path.join(
          dirPath,
          baseFilename.replace(".tex", ".log")
        );
        console.log("Reading log file from:", logPath);
        const logContent = await fs.readFile(logPath, "utf-8");
        const errors = parseLatexErrors(logContent);
        console.log("Parsed LaTeX errors:", errors);

        // If we have a PDF, return it along with any warnings
        return res.status(200).json({
          success: true,
          pdf: pdfBase64,
          output: formatLatexOutput(stdout1 + stdout2 + stdout3),
          errors: errors,
          warnings: errors.length > 0,
        });
      } catch (pdfError) {
        console.error("Failed to read PDF:", pdfError);
        // Log the directory contents to help debug
        const dirContents = await fs.readdir(dirPath);
        console.log("Directory contents:", dirContents);
        throw new Error(
          `No PDF was generated. Directory contents: ${dirContents.join(", ")}`
        );
      }
    } catch (error) {
      console.error("Compilation error:", error);
      res.status(500).json({
        error: "PDF compilation failed",
        details: error.message,
        output: formatLatexOutput(
          stdout1 + stdout2 + stdout3 || "No compilation output available"
        ),
      });
    }
  } catch (error) {
    console.error("Top-level error:", error);
    res.status(500).json({
      error: "Server error",
      details: error.message,
      output: formatLatexOutput(
        stdout1 + stdout2 + stdout3 || "No compilation output available"
      ),
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
