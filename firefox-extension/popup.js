(function () {
  "use strict";

  const extensionApi = globalThis.browser || globalThis.chrome;
  const STORAGE_KEY = "shelfApiConfiguration";
  const DEFAULT_API_BASE_URL = "http://localhost:9876/api/v1";
  const REQUEST_TIMEOUT_MS = 10_000;
  const SERVER_HELP = "Start Shelf's API server in Settings → API server if it is not running, then try again.";

  const elements = {
    configForm: document.querySelector("#config-form"),
    configPanel: document.querySelector("#config-panel"),
    configStatus: document.querySelector("#config-status"),
    apiBaseUrl: document.querySelector("#api-base-url"),
    toggleConfig: document.querySelector("#toggle-config"),
    closeConfig: document.querySelector("#close-config"),
    connectionBanner: document.querySelector("#connection-banner"),
    connectionIndicator: document.querySelector("#connection-indicator"),
    bookmarkForm: document.querySelector("#bookmark-form"),
    bookmarkUrl: document.querySelector("#bookmark-url"),
    bookmarkTitle: document.querySelector("#bookmark-title"),
    bookmarkDescription: document.querySelector("#bookmark-description"),
    bookmarkTags: document.querySelector("#bookmark-tags"),
    bookmarkCollection: document.querySelector("#bookmark-collection"),
    bookmarkNotes: document.querySelector("#bookmark-notes"),
    saveOfflineCopy: document.querySelector("#save-offline-copy"),
    favorite: document.querySelector("#bookmark-favorite"),
    archived: document.querySelector("#bookmark-archived"),
    fetchMetadata: document.querySelector("#fetch-metadata"),
    refreshCollections: document.querySelector("#refresh-collections"),
    metadataStatus: document.querySelector("#metadata-status"),
    saveStatus: document.querySelector("#save-status"),
    saveBookmark: document.querySelector("#save-bookmark"),
  };

  let apiBaseUrl = "";
  let hasSavedConfiguration = false;
  let collectionRequestId = 0;
  let lastCollectionErrorMessage = "";
  let configurationBusy = false;

  class ApiRequestError extends Error {
    constructor(message, status = 0, network = false) {
      super(message);
      this.name = "ApiRequestError";
      this.status = status;
      this.network = network;
    }
  }

  function setStatus(element, message, kind = "info", busy = false) {
    if (!element) return;
    element.className = `status ${kind}`;
    element.replaceChildren();
    element.hidden = !message;
    if (!message) return;
    if (busy) {
      const spinner = document.createElement("span");
      spinner.className = "spinner";
      spinner.setAttribute("aria-hidden", "true");
      element.append(spinner);
    }
    const copy = document.createElement("span");
    copy.textContent = message;
    element.append(copy);
  }

  function setConnectionIndicator(kind, title) {
    if (!elements.connectionIndicator) return;
    elements.connectionIndicator.className = `connection-indicator ${kind}`;
    elements.connectionIndicator.title = title;
  }

  function showConnection(message, kind = "info") {
    setConnectionIndicator(kind === "error" ? "offline" : kind === "warning" ? "warning" : "unknown", message);
    if (!message) {
      elements.connectionBanner.hidden = true;
      elements.connectionBanner.textContent = "";
      return;
    }
    elements.connectionBanner.className = `connection-banner ${kind}`;
    elements.connectionBanner.textContent = message;
    elements.connectionBanner.hidden = false;
  }

  function markConnected() {
    setConnectionIndicator("online", `Connected to Shelf at ${apiBaseUrl}`);
    elements.connectionBanner.hidden = true;
    elements.connectionBanner.textContent = "";
  }

  function formatError(error) {
    if (error instanceof ApiRequestError) {
      if (error.network) return `${error.message} ${SERVER_HELP}`;
      if (error.status === 423) return "Shelf is locked. Unlock the app and try again.";
      if (error.status === 404) return `${error.message} Check that the API base URL ends with /api/v1.`;
      return error.message;
    }
    if (error instanceof Error && error.message) return error.message;
    return "Something unexpected happened.";
  }

  function setConfigPanelOpen(open) {
    elements.configPanel.hidden = !open;
    elements.toggleConfig.setAttribute("aria-expanded", String(open));
    if (open) {
      elements.apiBaseUrl.value = apiBaseUrl || elements.apiBaseUrl.value || DEFAULT_API_BASE_URL;
      window.setTimeout(() => elements.apiBaseUrl.focus(), 0);
    }
  }

  function normalizeApiBaseUrl(rawValue) {
    const value = String(rawValue || "").trim();
    if (!value) throw new Error("Enter the Shelf API base URL.");

    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error("Enter a valid HTTP or HTTPS API URL.");
    }
    if (!/^https?:$/.test(parsed.protocol)) throw new Error("The Shelf API URL must use http or https.");
    if (parsed.username || parsed.password) throw new Error("API URLs cannot contain a username or password.");
    if (parsed.search || parsed.hash) throw new Error("Remove the query string or fragment from the API URL.");

    let path = parsed.pathname.replace(/\/+$/, "");
    if (!path || path === "/") {
      path = "/api/v1";
    } else if (!/\/api\/v1$/i.test(path)) {
      path += "/api/v1";
    }
    parsed.pathname = path;
    return parsed.toString().replace(/\/$/, "");
  }

  function normalizeBookmarkUrl(rawValue) {
    const value = String(rawValue || "").trim();
    if (!value) throw new Error("A URL is required.");
    const candidate = /^(?:https?:)\/\//i.test(value)
      ? value
      : /^[a-z][a-z\d+.-]*:\/\//i.test(value)
        ? value
        : `https://${value}`;
    let parsed;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new Error("That URL does not look valid.");
    }
    if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname) {
      throw new Error("Only http and https bookmark URLs are supported.");
    }
    return candidate;
  }

  function apiUrl(path) {
    return `${apiBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  }

  async function requestJson(path, options = {}) {
    if (!apiBaseUrl) throw new ApiRequestError("Save the Shelf API configuration before using it.");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const headers = new Headers(options.headers || {});
    if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");

    let response;
    try {
      response = await fetch(apiUrl(path), {
        ...options,
        headers,
        credentials: "omit",
        cache: "no-store",
        signal: controller.signal,
      });
    } catch (error) {
      if (error && error.name === "AbortError") {
        throw new ApiRequestError(`Shelf API did not respond within ${REQUEST_TIMEOUT_MS / 1000} seconds.`, 0, true);
      }
      throw new ApiRequestError(`Could not reach Shelf at ${apiBaseUrl}.`, 0, true);
    } finally {
      window.clearTimeout(timeout);
    }

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }
    if (!response.ok) {
      const message = typeof data?.error === "string"
        ? data.error
        : typeof data?.raw === "string" && data.raw.trim()
          ? data.raw.trim().slice(0, 220)
          : response.statusText || `Shelf API returned HTTP ${response.status}.`;
      throw new ApiRequestError(message, response.status);
    }
    return data;
  }

  function renderCollections(collections, emptyMessage = "No collections found") {
    const validCollections = collections.filter((collection) => collection && typeof collection.id === "string" && typeof collection.name === "string");
    const selected = elements.bookmarkCollection.value;
    elements.bookmarkCollection.replaceChildren();
    const noCollection = document.createElement("option");
    noCollection.value = "";
    noCollection.textContent = "No collection";
    elements.bookmarkCollection.append(noCollection);

    if (!validCollections.length) {
      const empty = document.createElement("option");
      empty.disabled = true;
      empty.textContent = emptyMessage;
      elements.bookmarkCollection.append(empty);
      elements.bookmarkCollection.value = "";
      return;
    }

    for (const collection of validCollections) {
      const option = document.createElement("option");
      option.value = collection.id;
      option.textContent = collection.name;
      elements.bookmarkCollection.append(option);
    }
    if (selected && validCollections.some((collection) => collection.id === selected)) elements.bookmarkCollection.value = selected;
  }

  async function loadCollections() {
    const requestId = ++collectionRequestId;
    if (!apiBaseUrl) {
      lastCollectionErrorMessage = "Save the Shelf API configuration first.";
      renderCollections([], "Configure the API to load collections");
      elements.bookmarkCollection.disabled = false;
      showConnection("Configure the Shelf API endpoint to load your collections.", "info");
      return false;
    }

    elements.refreshCollections.disabled = true;
    elements.bookmarkCollection.disabled = true;
    try {
      const collections = await requestJson("/collections");
      if (requestId !== collectionRequestId) return false;
      if (!Array.isArray(collections)) throw new ApiRequestError("Shelf returned an invalid collections response.");
      renderCollections(collections);
      elements.bookmarkCollection.disabled = false;
      lastCollectionErrorMessage = "";
      markConnected();
      return true;
    } catch (error) {
      if (requestId !== collectionRequestId) return false;
      renderCollections([], "Collections unavailable");
      elements.bookmarkCollection.disabled = false;
      lastCollectionErrorMessage = formatError(error);
      showConnection(formatError(error), error instanceof ApiRequestError && error.network ? "error" : "warning");
      return false;
    } finally {
      if (requestId === collectionRequestId) elements.refreshCollections.disabled = false;
    }
  }

  async function loadCurrentTab() {
    try {
      const tabs = await extensionApi.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (tab && typeof tab.url === "string" && tab.url) {
        try {
          const url = normalizeBookmarkUrl(tab.url);
          elements.bookmarkUrl.value = url;
        } catch {
          elements.bookmarkUrl.value = "";
          setStatus(elements.metadataStatus, "This tab is not a web page. Enter an http or https URL to save it.", "warning");
        }
      }
    } catch {
      setStatus(elements.metadataStatus, "Enter the page URL manually if the current tab could not be read.", "warning");
    }
  }

  async function saveConfiguration(event) {
    event.preventDefault();
    if (configurationBusy) return;
    let normalized;
    try {
      normalized = normalizeApiBaseUrl(elements.apiBaseUrl.value);
    } catch (error) {
      setStatus(elements.configStatus, error.message || "Enter a valid API URL.", "error");
      return;
    }

    configurationBusy = true;
    elements.apiBaseUrl.disabled = true;
    elements.configForm.querySelector("#save-config").disabled = true;
    setStatus(elements.configStatus, "Saving locally and checking Shelf…", "busy", true);
    try {
      await extensionApi.storage.local.set({
        [STORAGE_KEY]: { baseUrl: normalized },
      });
      apiBaseUrl = normalized;
      hasSavedConfiguration = true;
      elements.apiBaseUrl.value = normalized;
      const connected = await loadCollections();
      if (connected) {
        setStatus(elements.configStatus, "Configuration saved. Shelf is ready.", "success");
        setConnectionIndicator("online", `Connected to Shelf at ${apiBaseUrl}`);
        window.setTimeout(() => setConfigPanelOpen(false), 350);
      } else {
        setStatus(elements.configStatus, `Configuration saved locally. ${lastCollectionErrorMessage || SERVER_HELP}`, "error");
      }
    } catch (error) {
      setStatus(elements.configStatus, error instanceof ApiRequestError ? formatError(error) : error.message || "Could not save the configuration.", "error");
    } finally {
      configurationBusy = false;
      elements.apiBaseUrl.disabled = false;
      elements.configForm.querySelector("#save-config").disabled = false;
    }
  }

  function parseTags(value) {
    return [...new Set(String(value || "").split(",").map((tag) => tag.trim().replace(/^#/, "").toLocaleLowerCase()).filter(Boolean))];
  }

  function payloadFromForm() {
    const url = normalizeBookmarkUrl(elements.bookmarkUrl.value);
    const title = elements.bookmarkTitle.value.trim();
    const description = elements.bookmarkDescription.value.trim();
    const notes = elements.bookmarkNotes.value.trim();
    const payload = {
      url,
      tags: parseTags(elements.bookmarkTags.value),
      collectionId: elements.bookmarkCollection.value || null,
      favorite: elements.favorite.checked,
      archived: elements.archived.checked,
      archiveMode: elements.saveOfflineCopy.checked ? "html" : "none",
      fetchMetadata: true,
      metadataBehavior: "add-new-only",
    };
    if (title) payload.title = title;
    if (description) payload.description = description;
    if (notes) payload.notes = notes;
    return payload;
  }

  function setBookmarkFormBusy(busy) {
    elements.bookmarkForm.querySelectorAll("input, textarea, select, button").forEach((control) => {
      control.disabled = busy;
    });
    elements.saveBookmark.textContent = busy ? "Saving…" : "Save bookmark →";
  }

  function findSavedBookmark(response, payload) {
    if (!Array.isArray(response?.bookmarks)) return null;
    const canonical = (value) => {
      try {
        const parsed = new URL(value);
        parsed.hash = "";
        return parsed.toString();
      } catch {
        return value;
      }
    };
    const target = canonical(payload.url);
    return response.bookmarks.find((bookmark) => bookmark && canonical(bookmark.url) === target) || null;
  }

  async function fetchMetadataPreview() {
    if (!apiBaseUrl) {
      setConfigPanelOpen(true);
      setStatus(elements.metadataStatus, "Save the Shelf API configuration first.", "error");
      return;
    }
    let url;
    try {
      url = normalizeBookmarkUrl(elements.bookmarkUrl.value);
    } catch (error) {
      setStatus(elements.metadataStatus, error.message || "Enter a valid URL first.", "error");
      elements.bookmarkUrl.focus();
      return;
    }

    elements.fetchMetadata.disabled = true;
    setStatus(elements.metadataStatus, "Reading page details…", "busy", true);
    try {
      const metadata = await requestJson("/metadata", {
        method: "POST",
        body: JSON.stringify({ url }),
      });
      if (!elements.bookmarkTitle.value.trim() && metadata?.title) elements.bookmarkTitle.value = metadata.title;
      if (!elements.bookmarkDescription.value.trim() && metadata?.description) elements.bookmarkDescription.value = metadata.description;
      markConnected();
      setStatus(elements.metadataStatus, "Details found. Adjust anything before saving.", "success");
    } catch (error) {
      if (error instanceof ApiRequestError && error.network) showConnection(formatError(error), "error");
      setStatus(elements.metadataStatus, formatError(error), "error");
    } finally {
      elements.fetchMetadata.disabled = false;
    }
  }

  async function saveBookmark(event) {
    event.preventDefault();
    if (!apiBaseUrl) {
      setConfigPanelOpen(true);
      setStatus(elements.saveStatus, "Save the Shelf API configuration first.", "error");
      return;
    }

    let payload;
    try {
      payload = payloadFromForm();
    } catch (error) {
      setStatus(elements.saveStatus, error.message || "Enter a valid bookmark URL.", "error");
      elements.bookmarkUrl.focus();
      return;
    }

    setBookmarkFormBusy(true);
    setStatus(elements.saveStatus, "Writing bookmark to Shelf…", "busy", true);
    try {
      const response = await requestJson("/bookmarks", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const saved = findSavedBookmark(response, payload);
      if (!elements.bookmarkTitle.value.trim() && saved?.title) elements.bookmarkTitle.value = saved.title;
      if (!elements.bookmarkDescription.value.trim() && saved?.description) elements.bookmarkDescription.value = saved.description;
      markConnected();
      const copyMessage = payload.archiveMode === "html"
        ? "Bookmark saved. Shelf is saving the offline copy in the background."
        : "Bookmark saved to Shelf.";
      setStatus(elements.saveStatus, copyMessage, "success");
    } catch (error) {
      if (error instanceof ApiRequestError && error.network) {
        showConnection(formatError(error), "error");
      } else if (error instanceof ApiRequestError) {
        markConnected();
      }
      setStatus(elements.saveStatus, formatError(error), "error");
    } finally {
      setBookmarkFormBusy(false);
    }
  }

  async function initialize() {
    if (!extensionApi) {
      showConnection("Firefox extension APIs are unavailable in this page.", "error");
      return;
    }

    elements.apiBaseUrl.value = DEFAULT_API_BASE_URL;
    try {
      const stored = await extensionApi.storage.local.get(STORAGE_KEY);
      const storedUrl = stored?.[STORAGE_KEY]?.baseUrl;
      if (typeof storedUrl === "string" && storedUrl.trim()) {
        try {
          apiBaseUrl = normalizeApiBaseUrl(storedUrl);
          hasSavedConfiguration = true;
          elements.apiBaseUrl.value = apiBaseUrl;
        } catch {
          setConfigPanelOpen(true);
          setStatus(elements.configStatus, "The saved API URL needs to be entered again.", "warning");
        }
      }
    } catch {
      setStatus(elements.configStatus, "Firefox could not read the saved API configuration.", "error");
    }

    await loadCurrentTab();
    if (apiBaseUrl) {
      await loadCollections();
    } else {
      renderCollections([], "Configure the API to load collections");
      setConfigPanelOpen(true);
      showConnection("Set up the Shelf API endpoint to load your collections.", "info");
    }
  }

  elements.toggleConfig.addEventListener("click", () => setConfigPanelOpen(elements.configPanel.hidden));
  elements.closeConfig.addEventListener("click", () => {
    if (hasSavedConfiguration) setConfigPanelOpen(false);
    else setStatus(elements.configStatus, "Save an API configuration before closing this panel.", "warning");
  });
  elements.configForm.addEventListener("submit", saveConfiguration);
  elements.bookmarkForm.addEventListener("submit", saveBookmark);
  elements.fetchMetadata.addEventListener("click", fetchMetadataPreview);
  elements.refreshCollections.addEventListener("click", async () => {
    if (!apiBaseUrl) {
      setConfigPanelOpen(true);
      setStatus(elements.configStatus, "Save the Shelf API configuration first.", "error");
      return;
    }
    await loadCollections();
  });

  if (document.readyState === "complete") {
    initialize();
  } else {
    window.addEventListener("load", initialize, { once: true });
  }
})();
