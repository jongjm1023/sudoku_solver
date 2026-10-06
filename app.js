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
      for (let c = 0; c < 9; c += 1) cellInputs[r * 9 + c].value = board[r][c] ? String(board[r][c]) : "";
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
      screenStatus.textContent = "이미지를 열었어요. 스도쿠판 영역을 드래그해 지정해 주세요.";
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
    const insetX = cellWidth * 0.14;
    const insetY = cellHeight * 0.14;
    const size = 144;
    const tile = document.createElement("canvas");
    tile.width = size;
    tile.height = size;
    const tileContext = tile.getContext("2d", { willReadFrequently: true });
    tileContext.fillStyle = "#fff";
    tileContext.fillRect(0, 0, size, size);
    tileContext.drawImage(
      canvas,
      left + col * cellWidth + insetX,
      top + row * cellHeight + insetY,
      cellWidth - 2 * insetX,
      cellHeight - 2 * insetY,
      0,
      0,
      size,
      size
    );

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
    return { image: tile, inkRatio: ink / gray.length };
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
      let checked = 0;
      let possibleDigits = 0;
      for (let r = 0; r < 9; r += 1) {
        for (let c = 0; c < 9; c += 1) {
          const cell = cropCell(r, c);
          checked += 1;
          if (cell.inkRatio >= 0.009) {
            possibleDigits += 1;
            const result = await worker.recognize(cell.image);
            const match = result.data.text.match(/[1-9]/);
            if (match) recognized[r][c] = Number(match[0]);
          }
          if (checked % 9 === 0) {
            screenStatus.textContent = "칸을 확인하고 있어요… " + checked + "/81";
            await new Promise((resolve) => requestAnimationFrame(resolve));
          }
        }
      }
      board = recognized;
      paintBoard();
      updateHint();
      const filled = recognized.flat().filter(Boolean).length;
      screenStatus.textContent = "읽기 완료: 숫자 " + filled + "개를 찾았어요. 잘못 읽은 칸은 아래에서 고쳐 주세요.";
      if (possibleDigits > filled) {
        boardMessage.textContent = "몇 칸은 숫자를 확정하지 못했어요. 화면과 비교해 비어 있는 칸을 입력해 주세요.";
      }
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
