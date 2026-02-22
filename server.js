require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { Readable } = require("stream");
const axios = require("axios");
const cloudinary = require("cloudinary").v2;
const OpenAI = require("openai");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const app = express();
app.use(cors());

const server = http.createServer(app);

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ["GET", "POST"],
  },
});

const uploadDir = path.join(__dirname, "temp_upload");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const socketChunks = new Map();

io.on("connection", (socket) => {
  console.log("🟢 Socket connected:", socket.id);
  socket.emit("connected");
  socketChunks.set(socket.id, []);

  socket.on("video-chunks", (data) => {
    try {
      console.log("🟢 Receiving chunk for:", data.filename);
      const chunks = socketChunks.get(socket.id);
      chunks.push(Buffer.from(data.chunks));
    } catch (error) {
      console.error("🔴 Error receiving chunk:", error);
      socket.emit("upload-error", { message: "Failed to receive chunk." });
    }
  });

  socket.on("process-video", async (data) => {
    const filePath = path.join(uploadDir, data.filename);

    try {
      console.log("🟡 Processing video:", data.filename);

      const chunks = socketChunks.get(socket.id);
      if (!chunks || chunks.length === 0) throw new Error("No chunks received");

      // Combine and write the video file
      const buffer = Buffer.concat(chunks);
      await fs.promises.writeFile(filePath, buffer);
      console.log("🟢 Video file written:", data.filename);

      // Step 1: Notify backend that processing has started
      const processing = await axios.post(
        `${process.env.NEXT_API_HOST}recording/${data.userId}/processing`,
        { filename: data.filename }
      );
      if (processing.data.status !== 200) throw new Error("Failed to start processing");

      // Step 2: Upload to Cloudinary
      const cloudinaryUpload = cloudinary.uploader.upload_stream(
        {
          resource_type: "video",
          folder: "opal",
          public_id: data.filename,
        },
        async (error, result) => {
          try {
            if (error) throw error;

            console.log("🟢 Uploaded to Cloudinary:", result.secure_url);
            socket.emit("upload-success", { url: result.secure_url });

            // Step 3: If PRO plan, transcribe and summarize
            if (processing.data.plan === "PRO" && buffer.length < 25_000_000) {
              try {
                const transcription = await openai.audio.transcriptions.create({
                  file: fs.createReadStream(filePath),
                  model: "whisper-1",
                  response_format: "text",
                });

                if (transcription) {
                  const completion = await openai.chat.completions.create({
                    model: "gpt-3.5-turbo",
                    messages: [
                      {
                        role: "system",
                        content:
                          `You are going to generate a title and a nice description using the speech to text transcription (${transcription}) and then return it in json format as {"title":<the title you gave>,"summary":<the summary you created> }`,
                      },
                      {
                        role: "user",
                        content: transcription,
                      },
                    ],
                  });

                  const resultJSON = completion.choices[0].message.content;

                  const summaryResponse = await axios.post(
                    `${process.env.NEXT_API_HOST}recording/${data.userId}/transcribe`,
                    {
                      filename: data.filename,
                      content: resultJSON,
                      transcript: transcription,
                    }
                  );

                  if (summaryResponse.data.status !== 200) {
                    console.warn("⚠️ Transcription summary update failed");
                  }
                }
              } catch (err) {
                console.error("🔴 Transcription/Summary error:", err);
              }
            }

            // Step 4: Notify backend processing is done
            const stopProcessing = await axios.post(
              `${process.env.NEXT_API_HOST}recording/${data.userId}/complete`,
              { filename: data.filename }
            );
            if (stopProcessing.data.status !== 200)
              throw new Error("Failed to complete processing");

            // Step 5: Delete temp file
            fs.unlink(filePath, (err) => {
              if (err) console.error("🔴 Error deleting temp file:", err);
              else console.log("🗑️ Deleted temp file:", data.filename);
            });
          } catch (err) {
            console.error("🔴 Cloudinary callback error:", err);
            socket.emit("upload-error", { message: err.message });
          }
        }
      );

      // Start upload
      fs.createReadStream(filePath).pipe(cloudinaryUpload);
    } catch (error) {
      console.error("🔴 Error in processing video:", error);
      socket.emit("upload-error", { message: error.message });
    } finally {
      socketChunks.set(socket.id, []); // clear chunks after processing
    }
  });

  socket.on("disconnect", () => {
    console.log("🔴 Socket disconnected:", socket.id);
    socketChunks.delete(socket.id);
  });
});

// Global error handling
process.on("unhandledRejection", (error) => {
  console.error("🔴 Unhandled Rejection:", error);
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🟢 Server listening on port ${PORT}`);
});
