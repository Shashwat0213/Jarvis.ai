/* =========================================================
   MCU TRACKER — FIREBASE BACKEND
   ---------------------------------------------------------
   Features:
     • Email / Password login + signup
     • Google sign-in
     • Firestore sync (watched / favorites)
     • Admin panel (list all users + stats)
     • Admin access via users/{uid}.role === "admin"
     • Auto-admin: mcutrackersupport@gmail.com

   Firebase Console Setup Required:
     1. Authentication → Sign-in methods → Enable Email/Password & Google
     2. Authentication → Settings → Authorized domains → add:
          localhost
          shashwat0213.github.io
     3. Firestore Database → Create → Rules (neeche diye hain)
========================================================= */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
    getAuth,
    onAuthStateChanged,
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    signOut,
    updateProfile,
    setPersistence,
    browserLocalPersistence,
    GoogleAuthProvider,
    signInWithPopup
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
    getFirestore,
    doc,
    getDoc,
    setDoc,
    collection,
    getDocs,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

/* =========================================================
   FIREBASE CONFIG
========================================================= */
const FIREBASE_CONFIG = {
    apiKey:            "AIzaSyAxiho1OLRry1mU8CRm6lQirUGQCVlNDWg",
    authDomain:        "marvel-mcu-tracker.firebaseapp.com",
    projectId:         "marvel-mcu-tracker",
    storageBucket:     "marvel-mcu-tracker.firebasestorage.app",
    messagingSenderId: "353104751639",
    appId:             "1:353104751639:web:9f5e43501ead4bbedd4052",
    measurementId:     "G-5DJXGHN0NV"
};

const ADMIN_EMAIL = "mcutrackersupport@gmail.com";

/* =========================================================
   STATE
========================================================= */
let firebaseApp, auth, db;
let activeUser = null;
let activeAdmin = false;
let cloudSaveInProgress = false;
let cloudSavePending = false;

/* =========================================================
   HELPERS
========================================================= */
const $ = id => document.getElementById(id);

function setMessage(msg, ok = false){
    const el = $("authMessage");
    if(!el) return;
    el.textContent = msg || "";
    el.style.color = ok ? "#6dff9a" : "#ff7b7b";
}

function setSyncStatus(text, state = "idle"){
    const el = $("firebaseSyncStatus");
    if(!el) return;
    el.textContent = "Firebase: " + text;
    el.dataset.state = state;
    el.style.borderColor =
        state === "ok"    ? "rgba(0,230,118,.45)" :
        state === "error" ? "rgba(255,80,80,.45)" :
                            "rgba(255,255,255,.12)";
}

/* Local tracker state — padho script.js se */
function getLocalTracker(){
    return {
        watched:   JSON.parse(localStorage.getItem("mcuWatched"))   || {},
        favorites: JSON.parse(localStorage.getItem("mcuFavorites")) || {},
        name:      localStorage.getItem("mcuV3Name") || ""
    };
}

/* Cloud state ko local mein apply karo */
function applyTrackerState(state){
    if(!state) return;
    if(state.watched)   localStorage.setItem("mcuWatched",   JSON.stringify(state.watched));
    if(state.favorites) localStorage.setItem("mcuFavorites", JSON.stringify(state.favorites));
    if(state.name)      localStorage.setItem("mcuV3Name",    state.name);

    /* Update script.js state through an explicit bridge; avoid eval. */
    if(typeof window.setMCUTrackerState === "function"){
        window.setMCUTrackerState({
            watched: state.watched || {},
            favorites: state.favorites || {},
            name: state.name || ""
        });
    } else {
        if(typeof window.renderMovies === "function") window.renderMovies();
        if(typeof window.renderV3 === "function") window.renderV3();
    }
}

/* =========================================================
   AUTH UI
========================================================= */
function openAuth(){
    $("authOverlay")?.classList.add("open");
    $("authOverlay")?.setAttribute("aria-hidden", "false");
    $("authEmail")?.focus();
}
function closeAuth(){
    $("authOverlay")?.classList.remove("open");
    $("authOverlay")?.setAttribute("aria-hidden", "true");
}

function setAuthMode(mode){
    const signup = mode === "signup";
    document.querySelectorAll(".auth-tab").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.authTab === mode);
    });
    $("authTitle").textContent    = signup ? "Create your account" : "Welcome back";
    $("authSubtitle").textContent = signup
        ? "Create a secure account for your MCU journey."
        : "Sign in to sync your MCU tracker across devices.";
    $("authNameField").style.display = signup ? "grid" : "none";
    $("authName").required = signup;
    $("authSubmit").textContent = signup ? "Create account" : "Login";
    setMessage("");
}

function updateAuthUI(){
    const userBox  = $("authUserBox");
    const loginBtn = $("authOpenBtn");
    const nameEl   = $("authUserName");
    const avatar   = $("authAvatar");
    const adminBtn = $("authAdminBtn");
    if(!userBox) return;

    if(activeUser){
        const name = activeUser.displayName || activeUser.email?.split("@")[0] || "User";
        userBox.style.display = "flex";
        loginBtn.style.display = "none";
        nameEl.textContent = name;
        avatar.textContent = name.trim().charAt(0).toUpperCase() || "U";
        adminBtn.style.display = activeAdmin ? "inline-block" : "none";
    } else {
        userBox.style.display = "none";
        loginBtn.style.display = "inline-block";
        adminBtn.style.display = "none";
    }
}

/* =========================================================
   CLOUD SYNC
========================================================= */
async function loadCloudState(){
    if(!activeUser || !db) return;
    setSyncStatus("loading…", "idle");

    try {
        const profileRef = doc(db, "users", activeUser.uid);
        const trackerRef = doc(db, "users", activeUser.uid, "private", "tracker");

        const [profileSnap, trackerSnap] = await Promise.all([
            getDoc(profileRef),
            getDoc(trackerRef)
        ]);

        const profile = profileSnap.exists() ? profileSnap.data() : {};
        const tracker = trackerSnap.exists() ? trackerSnap.data() : null;

        /* Profile name sync */
        if(profile.displayName && profile.displayName !== activeUser.displayName){
            try { await updateProfile(activeUser, { displayName: profile.displayName }); } catch(e){}
        }

        if(tracker){
            applyTrackerState({
                watched:   tracker.watched   || {},
                favorites: tracker.favorites || {},
                name:      profile.displayName || tracker.name || ""
            });
        } else {
            /* First time login — apna local data upload karo */
            await saveCloudState();
        }

        setSyncStatus("synced", "ok");
    } catch(err){
        console.error("loadCloudState error:", err);
        setSyncStatus("load failed", "error");
    }
}

async function saveCloudState(){
    if(!activeUser || !db) return false;
    if(cloudSaveInProgress){ cloudSavePending = true; return false; }

    cloudSaveInProgress = true;
    try {
        do {
            cloudSavePending = false;
            const state = getLocalTracker();
            const name  = state.name || activeUser.displayName || activeUser.email?.split("@")[0] || "User";

            const profileRef = doc(db, "users", activeUser.uid);
            const trackerRef = doc(db, "users", activeUser.uid, "private", "tracker");

            await setDoc(profileRef, {
                uid: activeUser.uid,
                email: activeUser.email || "",
                displayName: name,
                updatedAt: serverTimestamp()
            }, { merge: true });

            await setDoc(trackerRef, {
                watched:   state.watched   || {},
                favorites: state.favorites || {},
                name,
                updatedAt: serverTimestamp()
            }, { merge: true });

            setSyncStatus("synced", "ok");
        } while(cloudSavePending);
        return true;
    } catch(err){
        console.error("saveCloudState error:", err);
        setSyncStatus("save failed", "error");
        return false;
    } finally {
        cloudSaveInProgress = false;
    }
}

/* Expose to script.js */
window.syncToFirebase = function(){
    if(activeUser) {
        setSyncStatus("saving…", "idle");
        saveCloudState();
    }
};

/* =========================================================
   AUTH ACTIONS
========================================================= */
async function handleAuthSubmit(e){
    e.preventDefault();
    if(!auth || !db){
        setMessage("Firebase not initialized. Please refresh.");
        return;
    }

    const mode     = document.querySelector(".auth-tab.active")?.dataset.authTab || "login";
    const email    = $("authEmail").value.trim();
    const password = $("authPassword").value;
    const name     = $("authName").value.trim();

    if(!email || !password) return;

    $("authSubmit").disabled = true;
    setMessage("Please wait…");

    try {
        if(mode === "signup"){
            const cred = await createUserWithEmailAndPassword(auth, email, password);
            if(name) await updateProfile(cred.user, { displayName: name });

            const isAdminEmail = email.toLowerCase() === ADMIN_EMAIL;
            await setDoc(doc(db, "users", cred.user.uid), {
                uid: cred.user.uid,
                email: cred.user.email || email,
                displayName: name || email.split("@")[0],
                role: isAdminEmail ? "admin" : "user",
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            }, { merge: true });

            activeUser = cred.user;
            const token = await cred.user.getIdTokenResult(true);
            activeAdmin = token.claims?.admin === true ||
                          isAdminEmail ||
                          (await getDoc(doc(db, "users", cred.user.uid))).data()?.role === "admin";

            updateAuthUI();
            closeAuth();
            setMessage("Account created ✓", true);
            await saveCloudState();

        } else {
            const cred = await signInWithEmailAndPassword(auth, email, password);
            activeUser = cred.user;

            /* Check admin role */
            const userDoc = await getDoc(doc(db, "users", cred.user.uid));
            const isAdminEmail = (cred.user.email || "").toLowerCase() === ADMIN_EMAIL;
            activeAdmin = isAdminEmail || userDoc.data()?.role === "admin";

            updateAuthUI();
            closeAuth();
            setMessage("Signed in ✓", true);
            await loadCloudState();
        }
    } catch(err){
        console.error(err);
        const messages = {
            "auth/invalid-credential":       "Email or password is incorrect.",
            "auth/email-already-in-use":     "That email is already registered.",
            "auth/weak-password":            "Password must be at least 6 characters.",
            "auth/invalid-email":            "Please enter a valid email address.",
            "auth/network-request-failed":   "Network error. Check your internet.",
            "auth/operation-not-allowed":    "Email/Password sign-in not enabled in Firebase.",
            "auth/unauthorized-domain":      "This domain is not authorized in Firebase.",
            "auth/user-disabled":            "This account has been disabled.",
            "permission-denied":             "Firestore permission denied. Check rules."
        };
        setMessage(messages[err.code] || err.message || "Authentication failed.");
    } finally {
        $("authSubmit").disabled = false;
    }
}

async function handleGoogleLogin(){
    if(!auth || !db){
        setMessage("Firebase not initialized.");
        return;
    }
    try {
        const provider = new GoogleAuthProvider();
        provider.setCustomParameters({ prompt: "select_account" });

        const result = await signInWithPopup(auth, provider);
        const user = result.user;
        const ref  = doc(db, "users", user.uid);
        const old  = await getDoc(ref);

        const isAdminEmail = (user.email || "").toLowerCase() === ADMIN_EMAIL;

        if(!old.exists()){
            await setDoc(ref, {
                uid: user.uid,
                email: user.email || "",
                displayName: user.displayName || "",
                role: isAdminEmail ? "admin" : "user",
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            });
        } else {
            await setDoc(ref, {
                uid: user.uid,
                email: user.email || old.data().email || "",
                displayName: user.displayName || old.data().displayName || "",
                updatedAt: serverTimestamp()
            }, { merge: true });
        }

        activeUser = user;
        activeAdmin = isAdminEmail || old.data()?.role === "admin";

        updateAuthUI();
        closeAuth();
        setSyncStatus("signed in", "ok");
        await loadCloudState();

    } catch(err){
        console.error(err);
        const messages = {
            "auth/unauthorized-domain":  "Add this domain in Firebase → Authentication → Authorized domains.",
            "auth/popup-blocked":        "Browser blocked the popup. Allow popups and try again.",
            "auth/popup-closed-by-user": "Google sign-in cancelled.",
            "auth/account-exists-with-different-credential":
                "This email already uses another sign-in method."
        };
        setMessage(messages[err.code] || err.message || "Google sign-in failed.");
    }
}

async function handleLogout(){
    if(!auth) return;
    try {
        await signOut(auth);
        activeUser = null;
        activeAdmin = false;
        updateAuthUI();
        setSyncStatus("not signed in", "idle");
    } catch(err){
        console.error(err);
    }
}

/* =========================================================
   ADMIN PANEL
========================================================= */
async function openAdminPanel(){
    if(!activeUser){ alert("Please login first."); return; }
    if(!activeAdmin){ alert("Admin access required."); return; }

    const overlay = $("adminOverlay");
    overlay.classList.add("open");
    overlay.setAttribute("aria-hidden", "false");

    const tbody = $("adminUserRows");
    tbody.innerHTML = '<tr><td colspan="5">Loading…</td></tr>';

    try {
        const usersSnap = await getDocs(collection(db, "users"));

        let totalUsers = 0;
        let totalAdmins = 0;
        let totalWatched = 0;
        let totalFavorites = 0;
        const rows = [];

        for(const userDoc of usersSnap.docs){
            totalUsers++;
            const data = userDoc.data() || {};

            const trackerSnap = await getDoc(doc(db, "users", userDoc.id, "private", "tracker"));
            const tracker = trackerSnap.exists() ? trackerSnap.data() : {};

            const watchedCount = Object.values(tracker.watched || {}).filter(Boolean).length;
            const favCount     = Object.values(tracker.favorites || {}).filter(Boolean).length;

            totalWatched   += watchedCount;
            totalFavorites += favCount;
            if(data.role === "admin") totalAdmins++;

            rows.push(`
                <tr>
                    <td><b>${escapeHTML(data.displayName || "User")}</b></td>
                    <td>${escapeHTML(data.email || "")}</td>
                    <td>${data.role === "admin" ? '<span style="color:#ffd979">admin</span>' : "user"}</td>
                    <td>${watchedCount}</td>
                    <td>${favCount}</td>
                </tr>
            `);
        }

        $("adminUsers").textContent     = totalUsers;
        $("adminAdmins").textContent    = totalAdmins;
        $("adminWatched").textContent   = totalWatched;
        $("adminFavorites").textContent = totalFavorites;

        tbody.innerHTML = rows.join("") || '<tr><td colspan="5">No users found.</td></tr>';

    } catch(err){
        console.error("Admin panel error:", err);
        tbody.innerHTML = '<tr><td colspan="5">Failed to load users. Check Firestore rules.</td></tr>';
    }
}

function closeAdminPanel(){
    $("adminOverlay")?.classList.remove("open");
    $("adminOverlay")?.setAttribute("aria-hidden", "true");
}

function escapeHTML(str){
    return String(str ?? "").replace(/[&<>"']/g, c => ({
        "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
    }[c]));
}

/* =========================================================
   BIND UI EVENTS
========================================================= */
$("authOpenBtn")?.addEventListener("click", openAuth);
$("authCloseBtn")?.addEventListener("click", closeAuth);
$("authOverlay")?.addEventListener("click", e => {
    if(e.target === $("authOverlay")) closeAuth();
});
document.querySelectorAll(".auth-tab").forEach(btn => {
    btn.addEventListener("click", () => setAuthMode(btn.dataset.authTab));
});
$("authForm")?.addEventListener("submit", handleAuthSubmit);
$("googleBtn")?.addEventListener("click", handleGoogleLogin);
$("authLogoutBtn")?.addEventListener("click", handleLogout);
$("authAdminBtn")?.addEventListener("click", openAdminPanel);
$("adminCloseBtn")?.addEventListener("click", closeAdminPanel);
$("adminOverlay")?.addEventListener("click", e => {
    if(e.target === $("adminOverlay")) closeAdminPanel();
});

/* =========================================================
   INIT FIREBASE
========================================================= */
(async function initFirebase(){
    try {
        firebaseApp = initializeApp(FIREBASE_CONFIG);
        auth = getAuth(firebaseApp);
        db   = getFirestore(firebaseApp);

        await setPersistence(auth, browserLocalPersistence);
        setSyncStatus("connected", "ok");

        onAuthStateChanged(auth, async user => {
            activeUser = user;
            activeAdmin = false;
            updateAuthUI();

            if(!user){
                setSyncStatus("not signed in", "idle");
                return;
            }

            try {
                const userDoc = await getDoc(doc(db, "users", user.uid));
                const isAdminEmail = (user.email || "").toLowerCase() === ADMIN_EMAIL;
                activeAdmin = isAdminEmail || userDoc.data()?.role === "admin";

                updateAuthUI();
                await loadCloudState();
            } catch(err){
                console.error("Auth state error:", err);
                setSyncStatus("sync failed", "error");
            }
        });

    } catch(err){
        console.error("Firebase initialization failed:", err);
        setSyncStatus("init failed", "error");
    }
})();

/* =========================================================
   PUBLIC HELPER (console se access ke liye)
========================================================= */
window.mcuFirebase = {
    get user(){ return activeUser; },
    get isAdmin(){ return activeAdmin; },
    openAuth,
    closeAuth,
    openAdminPanel,
    manualSync: saveCloudState,
    get configured(){ return !!auth; }
};

console.log("🔥 Firebase module loaded.");
