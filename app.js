(function () {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const canvas = $("#screen-canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const video = $("#screen-video");
  const shareButton = $("#share-button");
  const captureButton = $("#capture-button");
  const stopButton = $("#stop-button");
  const imageFile = $("#image-file");
  const readButton = $("#read-button");
  const selectionBox = $("#selection-box");
  const stagePlaceholder = $("#stage-placeholder");
  const screenStatus = $("#screen-status");
  const selectionHelp = $("#selection-help");
  const gridElement = $("#sudoku-grid");
  const hintTitle = $("#hint-title");
  const hintReason = $("#hint-reason");
  const applyButton = $("#apply-button");
  const boardMessage = $("#board-message");
  const cellInputs = [];

  let board = Array.from({ length: 9 }, () => Array(9).fill(0));
  let uncertainCells = new Set();
  let nextHint = null;
  let stream = null;
  let selection = null;
  let dragStart = null;
  let tesseractPromise = null;

  // Rules are data and hooks consumed by the shared candidate and hint engine.
  // A variant can add units, peer relationships, or candidate restrictions here.
  const ruleRegistry = {
    classic: {
      name: "클래식 스도쿠",
      units() {
        const units = [];
        for (let r = 0; r < 9; r += 1) {
          units.push({ kind: "row", index: r, label: (r + 1) + "행", cells: Array.from({ length: 9 }, (_, c) => r * 9 + c) });
        }
        for (let c = 0; c < 9; c += 1) {
          units.push({ kind: "column", index: c, label: (c + 1) + "열", cells: Array.from({ length: 9 }, (_, r) => r * 9 + c) });
        }
        for (let br = 0; br < 3; br += 1) {
          for (let bc = 0; bc < 3; bc += 1) {
            const cells = [];
            for (let dr = 0; dr < 3; dr += 1) {
              for (let dc = 0; dc < 3; dc += 1) cells.push((br * 3 + dr) * 9 + bc * 3 + dc);
            }
            units.push({ kind: "box", index: br * 3 + bc, label: (br * 3 + bc + 1) + "번 3×3 상자", cells });
          }
        }
        return units;
      },
      restrictCandidates(_grid, _cell, candidates) {
        return candidates;
      }
    }
  };

  const activeRule = ruleRegistry.classic;

  function buildBoardInputs() {
    for (let r = 0; r < 9; r += 1) {
      for (let c = 0; c < 9; c += 1) {
        const input = document.createElement("input");
        input.className = "cell";
        input.type = "text";
        input.inputMode = "numeric";
        input.autocomplete = "off";
        input.maxLength = 1;
        input.setAttribute("aria-label", (r + 1) + "행 " + (c + 1) + "열");
        if (c === 2 || c === 5) input.classList.add("box-right");
        if (r === 2 || r === 5) input.classList.add("box-bottom");
        input.addEventListener("input", () => {
          const digit = input.value.match(/[1-9]/);
          input.value = digit ? digit[0] : "";
          board[r][c] = digit ? Number(digit[0]) : 0;
          uncertainCells.delete(r * 9 + c);
          input.classList.remove("ocr-uncertain");
          input.removeAttribute("title");
          updateHint();
        });
        input.addEventListener("keydown", (event) => {
          const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
          if (!moves[event.key]) return;
          const nr = r + moves[event.key][0];
          const nc = c + moves[event.key][1];
          if (nr >= 0 && nr < 9 && nc >= 0 && nc < 9) {
            event.preventDefault();
            cellInputs[nr * 9 + nc].focus();
            cellInputs[nr * 9 + nc].select();
          }
        });
        gridElement.append(input);
        cellInputs.push(input);
      }
    }
    paintBoard();
  }

  function paintBoard() {
    for (let r = 0; r < 9; r += 1) {
      for (let c = 0; c < 9; c += 1) {
        const index = r * 9 + c;
        const input = cellInputs[index];
        input.value = board[r][c] ? String(board[r][c]) : "";
        input.classList.toggle("ocr-uncertain", uncertainCells.has(index));
        if (uncertainCells.has(index)) input.title = "인식 확신도가 낮아요. 원본 화면과 비교해 주세요.";
        else input.removeAttribute("title");
      }
    }
  }

  function makeSnapshot(width, height, draw) {
    if (!width || !height) return;
    canvas.width = width;
    canvas.height = height;
    draw(context, width, height);
    canvas.hidden = false;
    stagePlaceholder.hidden = true;
    selection = null;
    selectionBox.hidden = true;
    readButton.disabled = true;
    selectionHelp.textContent = "스도쿠판의 왼쪽 위부터 오른쪽 아래까지 드래그하세요.";
  }

  async function startScreenShare() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      screenStatus.textContent = "이 브라우저에서는 화면 공유를 사용할 수 없어요. 이미지 열기를 이용해 주세요.";
      return;
    }
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      video.srcObject = stream;
      await video.play();
      shareButton.disabled = true;
      captureButton.disabled = false;
      stopButton.disabled = false;
      screenStatus.textContent = "화면을 공유 중이에요. 퍼즐판이 보이는 상태에서 현재 화면 캡처를 누르세요.";
      stream.getVideoTracks()[0].addEventListener("ended", stopScreenShare, { once: true });
    } catch (error) {
      if (error.name !== "NotAllowedError") screenStatus.textContent = "화면 공유를 시작하지 못했어요. 다시 시도하거나 이미지 열기를 이용해 주세요.";
    }
  }

  function stopScreenShare() {
    if (stream) stream.getTracks().forEach((track) => track.stop());
    stream = null;
    video.srcObject = null;
    shareButton.disabled = false;
    captureButton.disabled = true;
    stopButton.disabled = true;
    screenStatus.textContent = "화면 공유를 껐어요.";
  }

  function captureSharedFrame() {
    if (!stream || !video.videoWidth) {
      screenStatus.textContent = "먼저 공유할 화면이나 창을 선택해 주세요.";
      return;
    }
    makeSnapshot(video.videoWidth, video.videoHeight, (ctx, width, height) => ctx.drawImage(video, 0, 0, width, height));
    screenStatus.textContent = "화면을 캡처했어요. 아래에서 스도쿠판 영역을 지정해 주세요.";
  }

  function showImageFile(file) {
    if (!file) return;
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);
    image.onload = () => {
      makeSnapshot(image.naturalWidth, image.naturalHeight, (ctx, width, height) => ctx.drawImage(image, 0, 0, width, height));
      if (image.naturalWidth / image.naturalHeight > 0.85 && image.naturalWidth / image.naturalHeight < 1.15) {
        selection = { x1: 0, y1: 0, x2: 1, y2: 1 };
        updateSelectionBox();
        selectionHelp.textContent = "정사각형 이미지를 퍼즐판으로 선택했어요. 영역을 바꾸려면 다시 드래그하세요.";
        screenStatus.textContent = "정사각형 이미지 전체를 퍼즐판으로 선택했어요. 숫자 읽기를 눌러 주세요.";
      } else {
        screenStatus.textContent = "이미지를 열었어요. 스도쿠판 영역을 드래그해 지정해 주세요.";
      }
      URL.revokeObjectURL(objectUrl);
    };
    image.onerror = () => {
      screenStatus.textContent = "이미지를 열 수 없어요. 다른 이미지 파일을 골라 주세요.";
      URL.revokeObjectURL(objectUrl);
    };
    image.src = objectUrl;
  }

  function pointerPosition(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))
    };
  }

  function updateSelectionBox() {
    if (!selection || canvas.hidden) {
      selectionBox.hidden = true;
      return;
    }
    const left = Math.min(selection.x1, selection.x2);
    const right = Math.max(selection.x1, selection.x2);
    const top = Math.min(selection.y1, selection.y2);
    const bottom = Math.max(selection.y1, selection.y2);
    selectionBox.hidden = false;
    selectionBox.style.left = (left * 100) + "%";
    selectionBox.style.top = (top * 100) + "%";
    selectionBox.style.width = ((right - left) * 100) + "%";
    selectionBox.style.height = ((bottom - top) * 100) + "%";
    readButton.disabled = right - left < 0.07 || bottom - top < 0.07;
  }

  function beginSelection(event) {
    if (!canvas.width) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    dragStart = pointerPosition(event);
    selection = { x1: dragStart.x, y1: dragStart.y, x2: dragStart.x, y2: dragStart.y };
    updateSelectionBox();
  }

  function moveSelection(event) {
    if (!dragStart || !selection) return;
    const position = pointerPosition(event);
    selection.x2 = position.x;
    selection.y2 = position.y;
    updateSelectionBox();
  }

  function endSelection(event) {
    if (!dragStart) return;
    moveSelection(event);
    dragStart = null;
    if (!readButton.disabled) selectionHelp.textContent = "영역이 지정됐어요. 숫자 읽기를 눌러 확인해 주세요.";
  }

  function cropCell(row, col) {
    const left = Math.min(selection.x1, selection.x2) * canvas.width;
    const top = Math.min(selection.y1, selection.y2) * canvas.height;
    const width = Math.abs(selection.x2 - selection.x1) * canvas.width;
    const height = Math.abs(selection.y2 - selection.y1) * canvas.height;
    const cellWidth = width / 9;
    const cellHeight = height / 9;
    // Keep most of each digit while excluding the heavier outer frame.
    const insetLeft = cellWidth * (col === 0 ? 0.20 : 0.14);
    const insetRight = cellWidth * (col === 8 ? 0.20 : 0.14);
    const insetTop = cellHeight * (row === 0 ? 0.20 : 0.14);
    const insetBottom = cellHeight * (row === 8 ? 0.24 : 0.14);
    const size = 192;
    const tile = document.createElement("canvas");
    tile.width = size;
    tile.height = size;
    const tileContext = tile.getContext("2d", { willReadFrequently: true });
    tileContext.fillStyle = "#fff";
    tileContext.fillRect(0, 0, size, size);
    tileContext.drawImage(
      canvas,
      left + col * cellWidth + insetLeft,
      top + row * cellHeight + insetTop,
      cellWidth - insetLeft - insetRight,
      cellHeight - insetTop - insetBottom,
      0,
      0,
      size,
      size
    );
    const rawImage = document.createElement("canvas");
    rawImage.width = size;
    rawImage.height = size;
    rawImage.getContext("2d").drawImage(tile, 0, 0);

    const imageData = tileContext.getImageData(0, 0, size, size);
    const histogram = new Uint32Array(256);
    const gray = new Uint8Array(size * size);
    for (let i = 0, pixel = 0; i < imageData.data.length; i += 4, pixel += 1) {
      const value = Math.round(imageData.data[i] * 0.299 + imageData.data[i + 1] * 0.587 + imageData.data[i + 2] * 0.114);
      gray[pixel] = value;
      histogram[value] += 1;
    }
    const threshold = Math.max(85, Math.min(205, otsuThreshold(histogram, size * size)));
    let ink = 0;
    for (let pixel = 0; pixel < gray.length; pixel += 1) {
      const value = gray[pixel] < threshold ? 0 : 255;
      if (value === 0) ink += 1;
      const index = pixel * 4;
      imageData.data[index] = value;
      imageData.data[index + 1] = value;
      imageData.data[index + 2] = value;
      imageData.data[index + 3] = 255;
    }
    tileContext.putImageData(imageData, 0, 0);
    return { image: tile, rawImage, inkRatio: ink / gray.length };
  }

  function otsuThreshold(histogram, total) {
    let sum = 0;
    for (let i = 0; i < 256; i += 1) sum += i * histogram[i];
    let backgroundWeight = 0;
    let backgroundSum = 0;
    let bestVariance = 0;
    let threshold = 150;
    for (let i = 0; i < 256; i += 1) {
      backgroundWeight += histogram[i];
      if (!backgroundWeight) continue;
      const foregroundWeight = total - backgroundWeight;
      if (!foregroundWeight) break;
      backgroundSum += i * histogram[i];
      const backgroundMean = backgroundSum / backgroundWeight;
      const foregroundMean = (sum - backgroundSum) / foregroundWeight;
      const variance = backgroundWeight * foregroundWeight * (backgroundMean - foregroundMean) ** 2;
      if (variance > bestVariance) {
        bestVariance = variance;
        threshold = i;
      }
    }
    return threshold;
  }

  function looksLikeTwo(image) {
    const width = image.width;
    const height = image.height;
    const pixels = image.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, width, height).data;
    const ink = (x, y) => pixels[(y * width + x) * 4] < 128;
    let minX = width;
    let maxX = -1;
    let minY = height;
    let maxY = -1;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (!ink(x, y)) continue;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
    if (maxX < minX || maxY < minY) return false;
    const glyphWidth = maxX - minX + 1;
    const glyphHeight = maxY - minY + 1;
    const aspect = glyphWidth / glyphHeight;
    if (aspect < 0.35 || aspect > 0.8) return false;

    function bandCentroid(start, end) {
      let totalInk = 0;
      let xSum = 0;
      const fromY = minY + Math.floor(glyphHeight * start);
      const toY = minY + Math.ceil(glyphHeight * end);
      for (let y = fromY; y < toY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          if (!ink(x, y)) continue;
          totalInk += 1;
          xSum += x - minX;
        }
      }
      return totalInk ? xSum / totalInk / glyphWidth : null;
    }

    const upperStroke = bandCentroid(0.20, 0.42);
    const descendingStroke = bandCentroid(0.57, 0.78);
    if (upperStroke === null || descendingStroke === null) return false;
    if (upperStroke < 0.62 || descendingStroke > 0.48 || upperStroke - descendingStroke < 0.18) return false;

    let baselineRows = 0;
    for (let y = minY + Math.floor(glyphHeight * 0.88); y <= maxY; y += 1) {
      let rowInk = 0;
      for (let x = minX; x <= maxX; x += 1) if (ink(x, y)) rowInk += 1;
      if (rowInk / glyphWidth >= 0.65) baselineRows += 1;
    }
    if (baselineRows < 2) return false;

    const localWidth = glyphWidth;
    const localHeight = glyphHeight;
    const outside = new Uint8Array(localWidth * localHeight);
    const queue = new Int32Array(localWidth * localHeight);
    let head = 0;
    let tail = 0;
    function addOutside(x, y) {
      const index = y * localWidth + x;
      if (outside[index] || ink(minX + x, minY + y)) return;
      outside[index] = 1;
      queue[tail] = index;
      tail += 1;
    }
    for (let x = 0; x < localWidth; x += 1) {
      addOutside(x, 0);
      addOutside(x, localHeight - 1);
    }
    for (let y = 0; y < localHeight; y += 1) {
      addOutside(0, y);
      addOutside(localWidth - 1, y);
    }
    while (head < tail) {
      const index = queue[head];
      head += 1;
      const x = index % localWidth;
      const y = Math.floor(index / localWidth);
      if (x > 0) addOutside(x - 1, y);
      if (x + 1 < localWidth) addOutside(x + 1, y);
      if (y > 0) addOutside(x, y - 1);
      if (y + 1 < localHeight) addOutside(x, y + 1);
    }
    for (let y = 1; y < localHeight - 1; y += 1) {
      for (let x = 1; x < localWidth - 1; x += 1) {
        if (!ink(minX + x, minY + y) && !outside[y * localWidth + x]) return false;
      }
    }
    return true;
  }

  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (tesseractPromise) return tesseractPromise;
    tesseractPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
      script.onload = () => resolve(window.Tesseract);
      script.onerror = () => {
        tesseractPromise = null;
        reject(new Error("OCR 구성 요소를 내려받지 못했어요. 인터넷 연결을 확인해 주세요."));
      };
      document.head.append(script);
    });
    return tesseractPromise;
  }

  async function readBoardFromImage() {
    if (!selection) return;
    readButton.disabled = true;
    shareButton.disabled = true;
    screenStatus.textContent = "숫자 인식 준비 중이에요. 처음에는 OCR 구성 요소를 내려받습니다.";
    let worker = null;
    try {
      const Tesseract = await loadTesseract();
      worker = await Tesseract.createWorker("eng", 1, {
        logger(message) {
          if (message.status === "recognizing text") {
            const percent = Math.round((message.progress || 0) * 100);
            screenStatus.textContent = "화면의 숫자를 읽는 중이에요… " + percent + "%";
          }
        }
      });
      await worker.setParameters({
        tessedit_char_whitelist: "123456789",
        tessedit_pageseg_mode: "10"
      });

      const recognized = Array.from({ length: 9 }, () => Array(9).fill(0));
      const uncertain = new Set();
      const visualCorrections = new Set();
      let checked = 0;
      let possibleDigits = 0;
      for (let r = 0; r < 9; r += 1) {
        for (let c = 0; c < 9; c += 1) {
          const cell = cropCell(r, c);
          checked += 1;
          if (cell.inkRatio >= 0.009) {
            possibleDigits += 1;
            let result = await worker.recognize(cell.image);
            let match = result.data.text.match(/[1-9]/);
            let confidence = Number(result.data.confidence);
            if (!match || confidence < 70) {
              await worker.setParameters({ tessedit_pageseg_mode: "8" });
              const alternate = await worker.recognize(cell.image);
              await worker.setParameters({ tessedit_pageseg_mode: "10" });
              const alternateMatch = alternate.data.text.match(/[1-9]/);
              const alternateConfidence = Number(alternate.data.confidence);
              if (alternateMatch && (!match || alternateConfidence > confidence)) {
                result = alternate;
                match = alternateMatch;
                confidence = alternateConfidence;
              }
            }
            if (!match || confidence < 55) {
              const alternate = await worker.recognize(cell.rawImage);
              const alternateMatch = alternate.data.text.match(/[1-9]/);
              const alternateConfidence = Number(alternate.data.confidence);
              if (alternateMatch && (!match || alternateConfidence > confidence)) {
                result = alternate;
                match = alternateMatch;
                confidence = alternateConfidence;
              }
            }
            if (!match || confidence < 40) {
              await worker.setParameters({ tessedit_pageseg_mode: "8" });
              const alternate = await worker.recognize(cell.rawImage);
              await worker.setParameters({ tessedit_pageseg_mode: "10" });
              const alternateMatch = alternate.data.text.match(/[1-9]/);
              const alternateConfidence = Number(alternate.data.confidence);
              if (alternateMatch && (!match || alternateConfidence > confidence)) {
                result = alternate;
                match = alternateMatch;
                confidence = alternateConfidence;
              }
            }
            if (!match || confidence < 55) {
              for (const image of [cell.image, cell.rawImage]) {
                for (const pageSegMode of ["13", "7"]) {
                  await worker.setParameters({ tessedit_pageseg_mode: pageSegMode });
                  const alternate = await worker.recognize(image);
                  const alternateMatch = alternate.data.text.match(/[1-9]/);
                  const alternateConfidence = Number(alternate.data.confidence);
                  if (alternateMatch && (!match || alternateConfidence > confidence)) {
                    result = alternate;
                    match = alternateMatch;
                    confidence = alternateConfidence;
                  }
                }
              }
              await worker.setParameters({ tessedit_pageseg_mode: "10" });
            }
            if (match) {
              const index = r * 9 + c;
              let digit = Number(match[0]);
              if (digit === 9 && confidence < 55 && looksLikeTwo(cell.image)) {
                digit = 2;
                visualCorrections.add(index);
              }
              recognized[r][c] = digit;
              if (confidence < 55 && !visualCorrections.has(index)) uncertain.add(index);
            }
          }
          if (checked % 9 === 0) {
            screenStatus.textContent = "칸을 확인하고 있어요… " + checked + "/81";
            await new Promise((resolve) => requestAnimationFrame(resolve));
          }
        }
      }
      const repaired = repairUnsolvableOcrClues(recognized, uncertain);
      board = repaired.board;
      uncertainCells = repaired.uncertain;
      paintBoard();
      updateHint();
      const filled = board.flat().filter(Boolean).length;
      screenStatus.textContent = "읽기 완료: 숫자 " + filled + "개를 찾았어요.";
      const notes = [];
      if (visualCorrections.size) notes.push(visualCorrections.size + "칸은 숫자 모양을 분석해 읽었어요. 원본과 대조해 주세요.");
      if (repaired.corrections.length) notes.push(repaired.corrections.length + "칸은 스도쿠 규칙과 대조해 숫자를 보정했어요.");
      if (uncertainCells.size) notes.push("노란색 " + uncertainCells.size + "칸은 인식 확신도가 낮아요. 원본과 대조해 주세요.");
      if (possibleDigits > filled) notes.push("일부 칸은 숫자를 읽지 못해 비어 있습니다.");
      if (notes.length) boardMessage.textContent = [boardMessage.textContent, ...notes].filter(Boolean).join(" ");
    } catch (error) {
      screenStatus.textContent = error.message || "숫자를 읽지 못했어요. 이미지가 선명한지 확인해 주세요.";
    } finally {
      if (worker) await worker.terminate();
      shareButton.disabled = Boolean(stream);
      readButton.disabled = false;
    }
  }

  function getUnits() {
    return activeRule.units();
  }

  function validateBoard(source) {
    const units = getUnits();
    for (const unit of units) {
      const seen = new Set();
      for (const index of unit.cells) {
        const value = source[Math.floor(index / 9)][index % 9];
        if (!value) continue;
        if (seen.has(value)) return "현재 퍼즐에 " + unit.label + " 숫자가 중복되어 있어요.";
        seen.add(value);
      }
    }
    return "";
  }

  function getCandidateMap(source) {
    const units = getUnits();
    const candidates = new Map();
    for (let index = 0; index < 81; index += 1) {
      const r = Math.floor(index / 9);
      const c = index % 9;
      if (source[r][c]) continue;
      const excluded = new Set();
      for (const unit of units) {
        if (!unit.cells.includes(index)) continue;
        for (const peer of unit.cells) {
          const value = source[Math.floor(peer / 9)][peer % 9];
          if (value) excluded.add(value);
        }
      }
      let options = new Set(Array.from({ length: 9 }, (_, i) => i + 1).filter((digit) => !excluded.has(digit)));
      options = activeRule.restrictCandidates(source, index, options);
      if (!options.size) return { candidates, conflict: (r + 1) + "행 " + (c + 1) + "열에 가능한 숫자가 없어요. 입력한 숫자를 확인해 주세요." };
      candidates.set(index, options);
    }
    return { candidates, conflict: "" };
  }

  function countSolutions(source, limit, nodeLimit) {
    if (validateBoard(source)) return { count: 0, exhausted: false };
    const working = source.map((row) => row.slice());
    let count = 0;
    let nodes = 0;
    let exhausted = false;

    function search() {
      if (count >= limit) return;
      if (nodes >= nodeLimit) {
        exhausted = true;
        return;
      }
      nodes += 1;
      const result = getCandidateMap(working);
      if (result.conflict) return;
      if (!result.candidates.size) {
        count += 1;
        return;
      }

      let bestIndex = -1;
      let bestOptions = null;
      for (const [index, options] of result.candidates) {
        if (!bestOptions || options.size < bestOptions.size) {
          bestIndex = index;
          bestOptions = options;
          if (options.size === 1) break;
        }
      }
      for (const digit of bestOptions) {
        const r = Math.floor(bestIndex / 9);
        const c = bestIndex % 9;
        working[r][c] = digit;
        search();
        working[r][c] = 0;
        if (count >= limit || exhausted) return;
      }
    }

    search();
    return { count, exhausted };
  }

  function repairUnsolvableOcrClues(source, uncertain) {
    const working = source.map((row) => row.slice());
    const remaining = new Set(uncertain);
    const corrections = [];
    for (let pass = 0; pass < uncertain.size; pass += 1) {
      const current = countSolutions(working, 1, 40000);
      if (current.count || current.exhausted) break;
      let corrected = false;
      for (const index of remaining) {
        const r = Math.floor(index / 9);
        const c = index % 9;
        const original = working[r][c];
        if (!original) continue;
        working[r][c] = 0;
        const candidateResult = getCandidateMap(working);
        const options = candidateResult.conflict ? [] : Array.from(candidateResult.candidates.get(index) || []);
        const possible = [];
        let searchLimited = false;
        for (const digit of options) {
          working[r][c] = digit;
          const attempt = countSolutions(working, 1, 40000);
          if (attempt.exhausted) {
            searchLimited = true;
            break;
          }
          if (attempt.count) possible.push(digit);
          if (possible.length > 1) break;
        }
        working[r][c] = original;
        if (!searchLimited && possible.length === 1) {
          working[r][c] = possible[0];
          remaining.delete(index);
          corrections.push({ index, from: original, to: possible[0] });
          corrected = true;
          break;
        }
      }
      if (!corrected) break;
    }
    return { board: working, uncertain: remaining, corrections };
  }

  function forcedMove(source, candidates, units) {
    for (const [index, options] of candidates) {
      if (options.size === 1) {
        const digit = options.values().next().value;
        const r = Math.floor(index / 9);
        const c = index % 9;
        return {
          index,
          digit,
          technique: "단일 후보",
          reason: (r + 1) + "행 " + (c + 1) + "열에 남은 후보는 " + digit + "뿐이에요."
        };
      }
    }
    for (const unit of units) {
      for (let digit = 1; digit <= 9; digit += 1) {
        let location = -1;
        let count = 0;
        for (const index of unit.cells) {
          if (source[Math.floor(index / 9)][index % 9] === 0 && candidates.get(index).has(digit)) {
            location = index;
            count += 1;
          }
        }
        if (count === 1) {
          const r = Math.floor(location / 9);
          const c = location % 9;
          return {
            index: location,
            digit,
            technique: "유일 후보",
            reason: unit.label + "에서 " + digit + "이 들어갈 수 있는 빈칸은 " + (r + 1) + "행 " + (c + 1) + "열뿐이에요."
          };
        }
      }
    }
    return null;
  }

  function tryElimination(candidates, removals, explanation, units, source) {
    let changed = false;
    for (const [index, digits] of removals) {
      const options = candidates.get(index);
      if (!options) continue;
      for (const digit of digits) {
        if (options.delete(digit)) changed = true;
      }
      if (!options.size) return { changed: true, conflict: (Math.floor(index / 9) + 1) + "행 " + (index % 9 + 1) + "열의 후보가 없어졌어요." };
    }
    if (!changed) return { changed: false };
    const forced = forcedMove(source, candidates, units);
    return { changed: true, hint: forced ? { ...forced, technique: "후보 제거", reason: explanation + " 그 결과 " + forced.reason } : null };
  }

  function boxLineElimination(source, candidates, units) {
    const regions = units.filter((unit) => unit.kind === "box" || unit.kind === "region");
    const rows = units.filter((unit) => unit.kind === "row");
    const columns = units.filter((unit) => unit.kind === "column");
    for (const region of regions) {
      for (let digit = 1; digit <= 9; digit += 1) {
        const places = region.cells.filter((index) => candidates.get(index) && candidates.get(index).has(digit));
        if (places.length < 2) continue;
        const row = Math.floor(places[0] / 9);
        if (places.every((index) => Math.floor(index / 9) === row)) {
          const removals = new Map();
          for (const index of rows[row].cells) {
            if (!region.cells.includes(index) && candidates.get(index) && candidates.get(index).has(digit)) removals.set(index, [digit]);
          }
          if (removals.size) {
            const result = tryElimination(candidates, removals, region.label + "의 " + digit + " 후보가 모두 " + (row + 1) + "행에 있으므로 그 행의 다른 칸에서 " + digit + " 후보를 지워요.", units, source);
            if (result.changed) return result;
          }
        }
        const column = places[0] % 9;
        if (places.every((index) => index % 9 === column)) {
          const removals = new Map();
          for (const index of columns[column].cells) {
            if (!region.cells.includes(index) && candidates.get(index) && candidates.get(index).has(digit)) removals.set(index, [digit]);
          }
          if (removals.size) {
            const result = tryElimination(candidates, removals, region.label + "의 " + digit + " 후보가 모두 " + (column + 1) + "열에 있으므로 그 열의 다른 칸에서 " + digit + " 후보를 지워요.", units, source);
            if (result.changed) return result;
          }
        }
      }
    }
    for (const unit of [...rows, ...columns]) {
      for (let digit = 1; digit <= 9; digit += 1) {
        const places = unit.cells.filter((index) => candidates.get(index) && candidates.get(index).has(digit));
        if (places.length < 2) continue;
        const region = regions.find((item) => places.every((index) => item.cells.includes(index)));
        if (!region) continue;
        const members = new Set(unit.cells);
        const removals = new Map();
        for (const index of region.cells) {
          if (!members.has(index) && candidates.get(index) && candidates.get(index).has(digit)) removals.set(index, [digit]);
        }
        if (removals.size) {
          const result = tryElimination(candidates, removals, unit.label + "의 " + digit + " 후보가 " + region.label + "에만 있으므로 그 영역의 다른 칸에서 " + digit + " 후보를 지워요.", units, source);
          if (result.changed) return result;
        }
      }
    }
    return { changed: false };
  }

  function combinations(items, count, start, current, output) {
    if (current.length === count) {
      output.push(current.slice());
      return;
    }
    for (let i = start; i <= items.length - (count - current.length); i += 1) {
      current.push(items[i]);
      combinations(items, count, i + 1, current, output);
      current.pop();
    }
  }

  function nakedSubsetElimination(source, candidates, units) {
    for (const unit of units) {
      const entries = unit.cells
        .filter((index) => candidates.has(index))
        .map((index) => ({ index, options: candidates.get(index) }))
        .filter((entry) => entry.options.size >= 2 && entry.options.size <= 3);
      for (let size = 2; size <= 3; size += 1) {
        const groups = [];
        combinations(entries, size, 0, [], groups);
        for (const group of groups) {
          const union = new Set(group.flatMap((entry) => Array.from(entry.options)));
          if (union.size !== size) continue;
          const locked = entries.filter((entry) => Array.from(entry.options).every((digit) => union.has(digit)));
          if (locked.length !== size) continue;
          const lockedCells = new Set(locked.map((entry) => entry.index));
          const removals = new Map();
          for (const entry of entries) {
            if (lockedCells.has(entry.index)) continue;
            const remove = Array.from(entry.options).filter((digit) => union.has(digit));
            if (remove.length) removals.set(entry.index, remove);
          }
          if (removals.size) {
            const digits = Array.from(union).sort().join(", ");
            const result = tryElimination(candidates, removals, unit.label + "에서 " + digits + " 후보가 " + size + "칸에 묶여 있어 다른 칸에서 해당 후보를 지워요.", units, source);
            if (result.changed) return result;
          }
        }
      }
    }
    return { changed: false };
  }

  function findNextHint(source) {
    const units = getUnits();
    const result = getCandidateMap(source);
    if (result.conflict) return { error: result.conflict };
    const candidates = result.candidates;
    const first = forcedMove(source, candidates, units);
    if (first) return { hint: first };

    const strategies = [
      () => boxLineElimination(source, candidates, units),
      () => nakedSubsetElimination(source, candidates, units)
    ];
    for (let iteration = 0; iteration < 300; iteration += 1) {
      let progressed = false;
      for (const strategy of strategies) {
        const step = strategy();
        if (step.conflict) return { error: step.conflict };
        if (step.hint) return { hint: step.hint };
        if (step.changed) {
          progressed = true;
          break;
        }
      }
      if (!progressed) break;
    }
    return { hint: null };
  }

  function updateHint() {
    $("#rule-name").textContent = activeRule.name;
    boardMessage.textContent = "";
    applyButton.disabled = true;
    nextHint = null;

    if (board.flat().every((value) => value === 0)) {
      hintTitle.textContent = "퍼즐을 입력하거나 화면을 읽어 주세요.";
      hintReason.textContent = "확정할 수 있는 숫자를 찾으면 풀이 이유도 함께 보여드려요.";
      return;
    }

    const duplicate = validateBoard(board);
    if (duplicate) {
      hintTitle.textContent = "입력한 숫자를 확인해 주세요.";
      hintReason.textContent = duplicate;
      boardMessage.textContent = duplicate;
      return;
    }

    const result = findNextHint(board);
    if (result.error) {
      hintTitle.textContent = "현재 퍼즐에서 모순을 찾았어요.";
      hintReason.textContent = result.error;
      boardMessage.textContent = result.error;
      return;
    }
    if (!result.hint) {
      if (board.flat().every(Boolean)) {
        hintTitle.textContent = "퍼즐을 모두 채웠어요!";
        hintReason.textContent = "입력한 행, 열, 3×3 상자마다 1부터 9까지 숫자가 한 번씩 있습니다.";
      } else {
        hintTitle.textContent = "지금 확인할 수를 찾지 못했어요.";
        hintReason.textContent = "현재 버전의 기본 논리 규칙으로는 다음 수를 확정하지 못했어요. 후보를 더 줄이는 고급 규칙이 필요한지, 읽힌 숫자가 맞는지 확인해 주세요.";
      }
      return;
    }

    nextHint = result.hint;
    const row = Math.floor(nextHint.index / 9) + 1;
    const col = nextHint.index % 9 + 1;
    hintTitle.textContent = row + "행 " + col + "열은 " + nextHint.digit + "입니다.";
    hintReason.textContent = nextHint.reason;
    applyButton.disabled = false;
  }

  function applyHint() {
    if (!nextHint) return;
    const appliedIndex = nextHint.index;
    const r = Math.floor(appliedIndex / 9);
    const c = appliedIndex % 9;
    board[r][c] = nextHint.digit;
    paintBoard();
    updateHint();
    cellInputs[appliedIndex].focus();
  }

  function clearBoard() {
    board = Array.from({ length: 9 }, () => Array(9).fill(0));
    uncertainCells.clear();
    paintBoard();
    updateHint();
    screenStatus.textContent = "퍼즐을 비웠어요. 화면을 읽거나 숫자를 직접 입력해 주세요.";
  }

  canvas.addEventListener("pointerdown", beginSelection);
  canvas.addEventListener("pointermove", moveSelection);
  canvas.addEventListener("pointerup", endSelection);
  canvas.addEventListener("pointercancel", endSelection);
  shareButton.addEventListener("click", startScreenShare);
  captureButton.addEventListener("click", captureSharedFrame);
  stopButton.addEventListener("click", stopScreenShare);
  imageFile.addEventListener("change", () => showImageFile(imageFile.files[0]));
  readButton.addEventListener("click", readBoardFromImage);
  applyButton.addEventListener("click", applyHint);
  $("#clear-button").addEventListener("click", clearBoard);

  buildBoardInputs();
  updateHint();
})();
