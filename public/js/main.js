/* ==========================================================
   AuditIQ — front-end wired to the Express backend
   ========================================================== */
(function () {
  "use strict";

  var API = ""; // same-origin; change if the API is hosted elsewhere

  /* ---------- helpers ---------- */
  function normalizeUrl(raw) {
    var v = (raw || "").trim();
    if (!v) return null;
    if (!/^https?:\/\//i.test(v)) v = "https://" + v;
    try {
      var u = new URL(v);
      return { full: u.href, host: u.hostname.replace(/^www\./, "") + (u.pathname !== "/" ? u.pathname : "") };
    } catch (e) {
      return null;
    }
  }

  function qs(name) {
    var params = new URLSearchParams(window.location.search);
    return params.get(name);
  }

  function formToObject(form) {
    var data = {};
    new FormData(form).forEach(function (value, key) {
      data[key] = value;
    });
    return data;
  }

  function postJson(url, body) {
    return fetch(API + url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data.error || "Request failed");
        return data;
      });
    });
  }

  function getJson(url) {
    return fetch(API + url).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data.error || "Request failed");
        return data;
      });
    });
  }

  /* ---------- URL audit form (home page hero) ---------- */
  document.querySelectorAll("[data-audit-form]").forEach(function (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var input = form.querySelector("input[type='text'], input[type='url']");
      var parsed = normalizeUrl(input.value);
      var errorEl = form.querySelector("[data-audit-error]");
      var submitBtn = form.querySelector("button[type='submit']");

      if (!parsed) {
        if (errorEl) errorEl.classList.remove("d-none");
        input.focus();
        return;
      }
      if (errorEl) errorEl.classList.add("d-none");
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Starting scan…";
      }

      postJson("/api/audit", { url: parsed.full })
        .then(function (data) {
          window.location.href =
            "audit-progress.html?jobId=" + encodeURIComponent(data.jobId) + "&site=" + encodeURIComponent(parsed.host);
        })
        .catch(function (err) {
          if (errorEl) {
            errorEl.textContent = "Could not start the scan (" + err.message + "). Please try again.";
            errorEl.classList.remove("d-none");
          }
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = "Run Free Audit";
          }
        });
    });
  });

  /* ---------- Currency toggle (USD default, INR alternate) ---------- */
  var currencyButtons = document.querySelectorAll("[data-currency-btn]");
  if (currencyButtons.length) {
    var applyCurrency = function (code) {
      currencyButtons.forEach(function (b) {
        b.classList.toggle("active", b.getAttribute("data-currency-btn") === code);
      });
      document.querySelectorAll("[data-usd][data-inr]").forEach(function (el) {
        el.textContent = code === "INR" ? el.getAttribute("data-inr") : el.getAttribute("data-usd");
      });
    };
    currencyButtons.forEach(function (b) {
      b.addEventListener("click", function () {
        applyCurrency(b.getAttribute("data-currency-btn"));
      });
    });
    var guessInr = /-IN$/i.test(navigator.language || "");
    applyCurrency(guessInr ? "INR" : "USD");
  }

  /* ---------- Pricing cadence toggle (monthly / annual) ---------- */
  var cadenceButtons = document.querySelectorAll("[data-cadence-btn]");
  if (cadenceButtons.length) {
    var applyCadence = function (mode) {
      cadenceButtons.forEach(function (b) {
        b.classList.toggle("active", b.getAttribute("data-cadence-btn") === mode);
      });
      document.querySelectorAll("[data-monthly][data-annual]").forEach(function (el) {
        el.textContent = mode === "annual" ? el.getAttribute("data-annual") : el.getAttribute("data-monthly");
      });
      document.querySelectorAll("[data-cadence-label]").forEach(function (el) {
        el.textContent = mode === "annual" ? "/mo, billed yearly" : "/month";
      });
    };
    cadenceButtons.forEach(function (b) {
      b.addEventListener("click", function () { applyCadence(b.getAttribute("data-cadence-btn")); });
    });
    applyCadence("monthly");
  }

  /* ---------- Audit progress page (polls the real job) ---------- */
  var scanRingBar = document.querySelector("[data-scan-ring-bar]");
  if (scanRingBar) {
    var jobId = qs("jobId");
    var site = qs("site") || "your website";
    var targetEl = document.querySelector("[data-scan-target]");
    if (targetEl) targetEl.textContent = site;

    var pctEl = document.querySelector("[data-scan-pct]");
    var noteEl = document.querySelector(".scan-note");
    var steps = document.querySelectorAll("[data-scan-step]");
    var STEP_KEYS = ["speed", "uiux", "technology", "seo", "security", "social"];
    var circumference = 339.3;
    var shown = 0;          // what the ring currently displays
    var target = 0;         // what the server says is really done
    var finished = false;

    function paint(pct) {
      var offset = circumference - (circumference * pct) / 100;
      scanRingBar.style.strokeDashoffset = offset;
      if (pctEl) pctEl.textContent = Math.round(pct) + "%";
    }

    function applySteps(serverSteps) {
      steps.forEach(function (li, i) {
        var st = serverSteps && serverSteps[STEP_KEYS[i]];
        li.classList.remove("is-active", "is-done");
        if (st === "done") li.classList.add("is-done");
        else if (st === "running") li.classList.add("is-active");
      });
    }
    applySteps({ speed: "running", uiux: "running" });

    if (!jobId) {
      window.location.href = "index.html";
    } else {
      // Ring animation: glide toward the REAL percentage from the server.
      // If the server is busy on one slow step (Google PageSpeed can take
      // 30-60s), creep very slowly so the page never looks frozen - but never
      // more than 5 points past what is truly done, and never past 97%.
      var animate = setInterval(function () {
        if (finished) return;
        if (shown < target) {
          shown += Math.max(0.3, (target - shown) * 0.12);
          if (shown > target) shown = target;
        } else {
          shown = Math.min(shown + 0.04, target + 5, 97);
        }
        paint(shown);
      }, 100);

      var poll = setInterval(function () {
        getJson("/api/audit/" + encodeURIComponent(jobId))
          .then(function (data) {
            if (data.progress && typeof data.progress.pct === "number") {
              target = Math.max(target, data.progress.pct);
              applySteps(data.progress.steps);
              if (noteEl && data.progress.message) noteEl.textContent = data.progress.message;
            }

            if (data.state === "completed") {
              finished = true;
              clearInterval(animate);
              clearInterval(poll);
              paint(100);
              applySteps({ speed: "done", uiux: "done", technology: "done", seo: "done", security: "done", social: "done" });
              setTimeout(function () {
                window.location.href =
                  "audit-result.html?jobId=" + encodeURIComponent(jobId) + "&site=" + encodeURIComponent(site);
              }, 600);
            } else if (data.state === "failed") {
              finished = true;
              clearInterval(animate);
              clearInterval(poll);
              if (noteEl) noteEl.textContent = "The scan failed to complete. Please try again from the homepage.";
            }
          })
          .catch(function () {
            /* transient network error - keep polling */
          });
      }, 1000);
    }
  }

  /* ---------- Audit result page (fetches the real report) ---------- */
  var overallRing = document.querySelector("[data-overall-ring]");
  if (overallRing) {
    var resultJobId = qs("jobId");
    var latestFormatted = null; // kept in memory for the gate-form unlock step

    function drawRing(ringEl, score) {
      var bar = ringEl.querySelector(".bar");
      var val = ringEl.querySelector(".val");
      var labelEl = ringEl.querySelector(".band-label");

      // A module that failed returns score: null - show that honestly
      // instead of drawing a misleading zero.
      if (typeof score !== "number") {
        if (val) val.textContent = "—";
        if (labelEl) labelEl.textContent = "Not available";
        return;
      }

      var circumference = parseFloat(bar.getAttribute("data-circumference") || "213.5");
      var offset = circumference - (circumference * score) / 100;
      ringEl.setAttribute("data-score-ring", score);
      requestAnimationFrame(function () {
        bar.style.strokeDashoffset = offset;
      });
      if (val) val.textContent = score;
      var band = score >= 80 ? "band-good" : score >= 50 ? "band-okay" : "band-poor";
      ringEl.classList.add(band);
      if (labelEl) labelEl.textContent = score >= 80 ? "Good" : score >= 50 ? "Okay" : "Needs work";
    }

    function severityClass(sev) {
      return { high: "sev-high", med: "sev-med", low: "sev-low" }[sev] || "sev-low";
    }

    function renderFindings(formatted) {
      var listEl = document.querySelector("[data-findings-list]");
      if (listEl) {
        listEl.innerHTML = formatted.findings
          .map(function (f) {
            return (
              '<li class="finding-item"><span class="finding-sev ' +
              severityClass(f.severity) +
              '"></span><div><span class="finding-cat">' +
              f.category +
              "</span><p>" +
              f.text +
              "</p></div></li>"
            );
          })
          .join("");
      }

      var countEl = document.querySelector("[data-locked-count]");
      var countTextEl = document.querySelector("[data-locked-count-text]");
      if (countEl) countEl.textContent = "+" + formatted.lockedCount;
      if (countTextEl) countTextEl.textContent = formatted.lockedCount + " more issue" + (formatted.lockedCount === 1 ? "" : "s") + " found";
    }

    function renderUnlockedChecklist(formatted) {
      var listEl = document.querySelector("[data-unlocked-list]");
      if (!listEl) return;
      var all = formatted.findings.concat(formatted.lockedFindings);
      listEl.innerHTML = all
        .map(function (f) {
          return "<li><strong>" + f.category + " —</strong> " + f.text + "</li>";
        })
        .join("");
    }

    function renderReport(data) {
      var formatted = data.formatted;
      latestFormatted = formatted;

      drawRing(overallRing, formatted.overallScore);

      // Show what was actually audited, so the score has visible provenance.
      var contextEl = document.querySelector("[data-overall-context]");
      if (contextEl) {
        var cov = formatted.coverage;
        contextEl.textContent = cov
          ? "Out of 100 — based on " + cov.pagesAudited + " page" + (cov.pagesAudited === 1 ? "" : "s") +
            " found via " + cov.discoveryMethod
          : "Out of 100";
      }

      Object.keys(formatted.categories).forEach(function (key) {
        var card = document.querySelector('.result-card[data-category="' + key + '"]');
        if (card) drawRing(card, formatted.categories[key].score);
      });

      renderFindings(formatted);
      renderUiUxVerdict(formatted);
      renderUiUxAnnotated(formatted);

      // Point the download button at this job's PDF endpoint.
      var dl = document.querySelector("[data-download-report]");
      if (dl && resultJobId) {
        dl.setAttribute("href", API + "/api/audit/" + encodeURIComponent(resultJobId) + "/report.pdf");
      }
    }

    function renderUiUxVerdict(formatted) {
      var uiux = formatted.categories.uiux;
      if (!uiux || !uiux.verdict) return;

      var host = document.querySelector("[data-findings-list]");
      if (!host || !host.parentElement) return;

      var box = document.querySelector("[data-uiux-verdict]");
      if (!box) {
        box = document.createElement("div");
        box.setAttribute("data-uiux-verdict", "");
        box.className = "lead-card mb-4";
        host.parentElement.insertBefore(box, host);
      }

      var strengths = (uiux.strengths || [])
        .map(function (s) { return "<li>" + s + "</li>"; })
        .join("");

      box.innerHTML =
        '<h3 class="mb-2">What a visitor sees first</h3>' +
        '<p class="mb-' + (strengths ? "3" : "0") + '">' + uiux.verdict + "</p>" +
        (strengths ? '<ul class="mb-0 small text-ink-soft">' + strengths + "</ul>" : "");
    }

    function esc(v) {
      return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
      });
    }

    /* "Where the problems are": each screenshot with numbered boxes drawn on
       the exact spot, and a matching numbered list of what's wrong + the fix. */
    function renderUiUxAnnotated(formatted) {
      var uiux = formatted.categories.uiux;
      if (!uiux || !uiux.screenshots || !uiux.screenshots.length) return;
      var issues = uiux.issues || [];
      if (!issues.length) return;

      var anchor = document.querySelector("[data-uiux-verdict]") || document.querySelector("[data-findings-list]");
      if (!anchor) return;
      var existing = document.querySelector("[data-uiux-annotated]");
      if (existing) existing.remove();

      var blocks = uiux.screenshots.map(function (shot) {
        var mine = issues.filter(function (i) { return i.screenshot === shot.index; });
        if (!mine.length) return "";
        var isMobile = /mobile/i.test(shot.label);
        var boxes = mine.filter(function (i) { return i.box; }).map(function (i) {
          return '<div class="shot-box sev-' + esc(i.severity) + '" style="left:' + i.box.x + "%;top:" + i.box.y +
                 "%;width:" + i.box.w + "%;height:" + i.box.h + '%"><span class="shot-pin">' + i.n + "</span></div>";
        }).join("");
        var list = mine.map(function (i) {
          return '<li class="shot-issue"><span class="shot-issue-n sev-' + esc(i.severity) + '">' + i.n + "</span><div>" +
                 "<strong>" + esc(i.what) + "</strong>" +
                 (i.why ? '<p class="mb-1 small">' + esc(i.why) + "</p>" : "") +
                 (i.fix ? '<p class="mb-0 small"><span class="fix-tag">How to fix</span> ' + esc(i.fix) + "</p>" : "") +
                 "</div></li>";
        }).join("");
        return '<div class="shot-block' + (isMobile ? " is-mobile" : "") + '">' +
          '<div class="shot-label">' + esc(shot.label) + "</div>" +
          '<div class="shot-frame"><img src="' + API + "/api/audit/" + encodeURIComponent(resultJobId) + "/screenshot/" + shot.index +
          '" alt="' + esc(shot.label) + '" loading="lazy">' + boxes + "</div>" +
          '<ol class="shot-issues">' + list + "</ol></div>";
      }).join("");

      var card = document.createElement("div");
      card.className = "lead-card mb-4";
      card.setAttribute("data-uiux-annotated", "");
      card.innerHTML =
        '<h3 class="mb-1">Where the design problems are</h3>' +
        '<p class="small mb-3">Numbered boxes show the exact spot on your site. Boxes are approximate, drawn by an AI review of these screenshots.</p>' +
        blocks;
      anchor.parentElement.insertBefore(card, anchor.tagName === "UL" ? anchor.parentElement.nextSibling : anchor.nextSibling);
    }

    if (!resultJobId) {
      // No job to show - fall back to a friendly message instead of a 6x "0" report.
      var heading = document.querySelector(".text-center h1");
      if (heading) heading.textContent = "Run an audit first";
    } else {
      (function poll() {
        getJson("/api/audit/" + encodeURIComponent(resultJobId))
          .then(function (data) {
            if (data.state === "completed" && data.formatted) {
              renderReport(data);
            } else if (data.state === "failed") {
              var note = document.querySelector(".container-copy");
              if (note) note.textContent = "This scan failed to complete. Please run a new audit from the homepage.";
            } else {
              setTimeout(poll, 1500); // still running - keep checking
            }
          })
          .catch(function () {
            setTimeout(poll, 2500);
          });
      })();
    }

    /* ---------- Lead gate unlock ---------- */
    var gateForm = document.querySelector("[data-gate-form]");
    if (gateForm) {
      gateForm.addEventListener("submit", function (e) {
        e.preventDefault();
        var payload = formToObject(gateForm);
        payload.jobId = resultJobId;
        payload.type = "gate";

        postJson("/api/lead", payload)
          .then(function (resp) {
            var emailNote = document.querySelector("[data-email-note]");
            if (emailNote) {
              emailNote.textContent = resp && resp.emailSent
                ? "We've emailed the full PDF report to " + payload.email + "."
                : "Your report is unlocked below. (We couldn't send the email just now — use the download button.)";
            }
            document.querySelectorAll(".gate-panel, [data-gated-cta]").forEach(function (el) {
              el.classList.add("d-none");
            });
            document.querySelectorAll(".blurred-preview").forEach(function (el) {
              el.classList.remove("blurred-preview");
            });
            if (latestFormatted) renderUnlockedChecklist(latestFormatted);
            var unlocked = document.querySelector("[data-unlocked-panel]");
            if (unlocked) unlocked.classList.remove("d-none");
            window.scrollTo({ top: unlocked ? unlocked.offsetTop - 90 : 0, behavior: "smooth" });
          })
          .catch(function (err) {
            alert("Could not unlock the report: " + err.message);
          });
      });
    }
  }

  document.querySelectorAll("[data-scan-target-echo]").forEach(function (el) {
    el.textContent = qs("site") || el.textContent;
  });

  /* ---------- Footer newsletter form (email only) ---------- */
  document.querySelectorAll("[data-newsletter-form]").forEach(function (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var payload = formToObject(form);
      payload.type = "newsletter";
      var successEl = form.parentElement.querySelector("[data-form-success]") || document.querySelector("[data-form-success]");

      postJson("/api/lead", payload)
        .then(function () {
          form.querySelectorAll("input, select, textarea, button").forEach(function (el) { el.disabled = true; });
          if (successEl) successEl.classList.remove("d-none");
        })
        .catch(function (err) {
          alert("Could not subscribe: " + err.message);
        });
    });
  });

  /* ---------- Consultation request form (consult.html) ---------- */
  document.querySelectorAll("[data-consult-form]").forEach(function (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var payload = formToObject(form);
      var successEl = document.querySelector("[data-form-success]");

      postJson("/api/consult", payload)
        .then(function () {
          form.querySelectorAll("input, select, textarea, button").forEach(function (el) { el.disabled = true; });
          if (successEl) successEl.classList.remove("d-none");
        })
        .catch(function (err) {
          alert("Could not send your request: " + err.message);
        });
    });
  });

  /* ---------- Free-trial signup form (subscription.html) ---------- */
  document.querySelectorAll("[data-trial-form]").forEach(function (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var payload = formToObject(form);
      var successEl = document.querySelector("[data-form-success]");

      postJson("/api/subscription/trial", payload)
        .then(function () {
          form.querySelectorAll("input, select, textarea, button").forEach(function (el) { el.disabled = true; });
          if (successEl) successEl.classList.remove("d-none");
        })
        .catch(function (err) {
          alert("Could not start your trial: " + err.message);
        });
    });
  });

  /* ---------- Reveal-on-scroll (single orchestrated pattern) ---------- */
  var revealEls = document.querySelectorAll(".js-fade-in");
  if (revealEls.length && "IntersectionObserver" in window) {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15 }
    );
    revealEls.forEach(function (el) { io.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add("is-visible"); });
  }
})();
