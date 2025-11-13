# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a browser-based video frame processor that uses the WebCodecs API to decode, process, and re-encode video files with timestamp overlays. The application runs entirely in the browser and supports frame-level video manipulation with options for zoom, rotation, and timestamp rendering.

## Build and Development Commands

```bash
# Build the project (creates dist/bundle.js)
npm run build

# Watch mode for development
npm run watch
```

The build process uses Webpack with Babel to transpile ES6+ JavaScript to support multiple browsers. The output is served from `dist/bundle.js` which is loaded by `index.html`.

## Git Commit Guidelines

**IMPORTANT**: Do NOT include Claude Code branding or attribution in commit messages. Specifically:
- ❌ Do not add "🤖 Generated with [Claude Code]" footers
- ❌ Do not add "Co-Authored-By: Claude" tags
- ✅ Write clear, concise commit messages without AI attribution
- ✅ Focus on explaining what changed and why

This keeps the git history clean and professional.

## Architecture Overview

### Core Processing Flow

The video processing follows a pipeline architecture:

1. **File Input** → `MP4Demuxer` (videoDecoder.js) extracts video samples and metadata
2. **Sample Management** → `SampleManager` (sampleManager.js) buffers and manages video samples
3. **Decoding** → `VideoDecoder` wrapper decodes frames using WebCodecs API
4. **Processing** → Frames are drawn to canvas with transformations and timestamp overlay
5. **Encoding** → `VideoEncoder` re-encodes frames with H.264 codec
6. **Output** → MP4 file is muxed and downloaded using mp4-muxer

### Key Components

**VideoProcessor (videoProcessor.js)**
- Orchestrates the entire workflow
- Manages state transitions (idle → initializing → initialized → processing → finalized)
- Handles both preview mode (single frame rendering) and full processing
- Coordinates between UI, samples, decoding, and encoding

**ProcessingPipeline (processingPipeline.js)**
- Manages the decode → transform → encode pipeline during full processing
- Handles backpressure between decoder and encoder queues
- Ensures frames are processed sequentially while maintaining timestamps
- Browser-specific handling: Chrome uses `ondequeue` events, others use timer-based dispatch

**SampleManager (sampleManager.js)**
- Stores video samples (compressed chunks) from demuxer
- Provides time-range and frame-range selection
- Handles keyframe seeking (rewinds to previous keyframe for decodability)
- Supplies chunks to decoder on demand

**VideoDecoder/VideoEncoder Wrappers**
- Thin wrappers around WebCodecs `VideoDecoder` and `VideoEncoder`
- Handle queue management and backpressure
- VideoEncoder forces keyframes at regular intervals (every fps frames) for better quality

**Resource Management**
- `ResourceManager` (resourceManager.js) tracks all VideoFrame objects to prevent memory leaks
- Automatic cleanup of frames older than 30 seconds
- Periodic cleanup runs every 10 seconds
- Critical: VideoFrames must be explicitly closed or they leak GPU memory

**Error Handling**
- `ErrorHandler` (errorHandler.js) provides centralized error handling
- Validates video files (max 1.5GB, supported formats only)
- Checks browser support for WebCodecs APIs
- Converts technical errors to user-friendly messages

### State Management

**VideoProcessorState (videoProcessorState.js)**
- Manages processor states: idle → initializing → initialized → processing → finalized → error
- Tracks processing promises for async coordination
- Ensures valid state transitions

**Preview vs Processing Mode**
- Preview: Uses a dedicated decoder to render single frames at slider positions
- Processing: Creates a new pipeline with its own decoder/encoder for full video export
- Both modes can coexist (preview while not processing)

### UI Management

**UIManager (uiManager.js)**
- Handles canvas operations and transformations
- Applies zoom and rotation to video frames
- Manages timestamp rendering via TimeStampRenderer

**TimeStampProvider/TimeStampRenderer**
- Calculates actual timestamps from video start time and user-provided offset
- Renders timestamp text overlay on frames during processing

**FrameRangeSlider (frameRangeSlider.js)**
- Dual-thumb slider for selecting frame ranges
- Updates preview in real-time as user drags thumbs

### Browser Compatibility

The codebase handles Chrome vs non-Chrome browsers differently:

- **Chrome-based**: Uses `ondequeue` events for optimal backpressure handling
- **Non-Chrome**: Uses timer-based dispatching (1 second intervals)
- **Encoder bitrate**: Chrome uses encoder's automatic bitrate; others use calculated bitrate (0.2 bits per pixel)

## Important Constants

From `logging.js`:
- `kDecodeQueueSize`: Controls decoder queue size for backpressure
- `kEncodeQueueSize`: Controls encoder queue size for backpressure

## Key Technical Details

### Keyframe Handling
When selecting a time range, the system automatically rewinds to the previous keyframe to ensure the first selected frame can be decoded. This is critical for compressed video formats where delta frames depend on prior keyframes.

### Timestamp Calculation
- Video samples have `cts` (composition timestamp) in timescale units
- Convert to milliseconds: `(sample.cts * 1000) / sample.timescale`
- Final timestamp accounts for: video start time + frame time + user offset

### Frame Processing Order
Frames are processed sequentially using promise chaining (`previousPromise`) to maintain timestamp order, even though decoding is asynchronous.

### Encoder Configuration
- Codec: H.264 High Profile Level 5.1 (`avc1.640033`)
- Max dimensions: 4096x2304 (currently scaling is disabled)
- Output dimensions: Rounded to multiples of 64 for encoder compatibility
- Keyframe interval: Every fps frames (approximately 1 second GOP)

### Memory Management
- All VideoFrame objects must be explicitly closed
- ResourceManager tracks frames and auto-closes after 30 seconds
- Use `resourceManager.processFrame()` wrapper for safe frame handling
- Canvas contexts are reused, never recreated during processing

## Dependencies

- **mp4box**: Demuxes MP4 files to extract samples
- **mp4-muxer**: Muxes encoded chunks into MP4 format
- **WebCodecs API**: Browser API for video decode/encode (Chrome 94+, Edge 94+, Safari 16.4+)

## Common Development Patterns

### Adding New Frame Transformations
1. Modify `UIManager.drawFrame()` to apply transformation before rendering
2. Canvas transforms are applied via `ctx.transform()` matrix
3. Ensure frame dimensions account for rotation in `getEncoderDimensions()`

### Adding New Processing Options
1. Add UI controls in `index.html`
2. Pass option through `VideoProcessor` constructor config
3. Access in `ProcessingPipeline.processFrame()` for per-frame application
4. Update `UIManager` if visual preview is needed

### Debugging Frame Issues
- Enable verbose logging in `logging.js`
- Check `ResourceManager.getStats()` for active frame counts
- Verify frames are closed: search for `.close()` calls
- Use browser's Task Manager to monitor GPU memory usage
