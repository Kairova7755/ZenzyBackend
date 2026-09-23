require("dotenv").config();

const express = require("express");
const cors = require("cors");
const Razorpay = require("razorpay");
const crypto = require("crypto");

const {
    initializeApp,
    applicationDefault,
    cert,
} = require("firebase-admin/app");

const {
    getAuth,
} = require("firebase-admin/auth");

const {
    getFirestore,
    Timestamp,
    FieldValue,
} = require("firebase-admin/firestore");

const {
    getMessaging,
} = require("firebase-admin/messaging");

const app = express();

app.use(cors());
app.use((req, res, next) => {
    if (req.path === "/razorpay-webhook") {
        return next();
    }
    return express.json({ limit: "2mb" })(req, res, next);
});

/*
 * --------------------------------------------------------------------------
 * Firebase Admin
 * --------------------------------------------------------------------------
 */

function getFirebaseCredential() {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;

    if (raw) {
        try {
            return cert(JSON.parse(raw));
        } catch (error) {
            console.error(
                "FIREBASE_SERVICE_ACCOUNT JSON ERROR:",
                error.message
            );
            throw new Error(
                "Invalid FIREBASE_SERVICE_ACCOUNT environment variable"
            );
        }
    }

    return applicationDefault();
}

initializeApp({
    credential: getFirebaseCredential(),
});

const db = getFirestore();
const adminAuth = getAuth();

const FIRST_TIME_OFFER_WINDOW_MS = 12 * 60 * 60 * 1000;
const MYSTERY_BOX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/*
 * --------------------------------------------------------------------------
 * Referral / Invite & Earn
 * --------------------------------------------------------------------------
 * Signup reward:
 *   Referred friend signs up through a valid invite -> referrer +50 Ruby.
 *
 * First Ruby purchase reward:
 *   Referred friend completes their first successful Ruby-pack payment
 *   (any Ruby pack/offer amount, including the ₹1 first-time offer) ->
 *   referrer +100 Ruby and referred friend +30 Ruby.
 *
 * All referral rewards are server-side and transaction protected.
 */
const REFERRAL_SIGNUP_REWARD = 50;
const REFERRAL_FIRST_PURCHASE_REFERRER_REWARD = 100;
const REFERRAL_FIRST_PURCHASE_FRIEND_REWARD = 30;

function makeReferralCode(uid) {
    const clean = String(uid || "")
        .replace(/[^a-zA-Z0-9]/g, "")
        .toUpperCase();

    // 10-12 chars keeps the share code short while remaining tied to the UID.
    return `Z${clean.slice(0, 11)}`;
}

function cleanReferralCode(value) {
    return String(value || "")
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 20);
}

async function ensureReferralCode(uid) {
    const userRef = db.collection("users").doc(uid);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
        throw new Error("USER_NOT_FOUND");
    }

    const userData = userDoc.data() || {};
    const existing = cleanReferralCode(userData.referralCode);

    if (existing) {
        return existing;
    }

    const code = makeReferralCode(uid);

    await userRef.set(
        {
            referralCode: code,
            updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
    );

    return code;
}


/*
 * --------------------------------------------------------------------------
 * Razorpay
 * --------------------------------------------------------------------------
 */

if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    console.warn("WARNING: Razorpay environment variables are missing.");
}

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
});

/*
 * --------------------------------------------------------------------------
 * Zenzy products
 * --------------------------------------------------------------------------
 */

const PRODUCTS = {
    monthly: {
        id: "monthly",
        type: "subscription",
        name: "Monthly Premium",
        amountInPaise: 100, // ₹1 initial payment/upfront authorization
        amountRupees: 1,
        aCoinReward: 650,
        renewalAmountRupees: 499,
        renewalPrice: 499,
        trialDays: 3,
        description: "Monthly Zenzy Subscription",
    },
    yearly: {
        id: "yearly",
        type: "subscription",
        name: "Yearly Premium",
        amountInPaise: 100, // ₹1 initial payment/upfront authorization
        amountRupees: 1,
        aCoinReward: 2800,
        renewalAmountRupees: 2100,
        renewalPrice: 2100,
        trialDays: 30, // 1 month
        description: "Yearly Zenzy Subscription",
    },
    new_user_100_ruby: {
        id: "new_user_100_ruby",
        type: "pack",
        name: "New User 100 Ruby Offer",
        amountInPaise: 2900, // ₹29
        amountRupees: 29,
        aCoinReward: 100,
        description: "100 Ruby New User Offer",
        newUserOnly: true,
    },
    first_time_20_ruby: {
        id: "first_time_20_ruby",
        type: "pack",
        name: "First Time 20 Ruby Offer",
        amountInPaise: 100, // ₹1
        amountRupees: 1,
        aCoinReward: 20,
        description: "20 Ruby First Time Offer",
        newUserOnly: true,
        firstTimeOnly: true,
    },
    coin_49: {
        id: "coin_49",
        type: "pack",
        name: "Starter A-Coin",
        amountInPaise: 4900, // ₹49
        amountRupees: 49,
        aCoinReward: 30,
        description: "30 A-Coins Pack",
    },
    coin_99: {
        id: "coin_99",
        type: "pack",
        name: "Boost A-Coin",
        amountInPaise: 9900, // ₹99
        amountRupees: 99,
        aCoinReward: 80,
        description: "80 A-Coins Pack",
    },
    coin_199: {
        id: "coin_199",
        type: "pack",
        name: "Popular A-Coin",
        amountInPaise: 21000, // ₹210
        amountRupees: 210,
        aCoinReward: 200,
        description: "200 A-Coins Pack",
    },
    coin_499: {
        id: "coin_499",
        type: "pack",
        name: "Pro A-Coin",
        amountInPaise: 49900, // ₹499
        amountRupees: 499,
        aCoinReward: 550,
        description: "550 A-Coins Pack",
    },
    coin_999: {
        id: "coin_999",
        type: "pack",
        name: "Ultra A-Coin",
        amountInPaise: 99900, // ₹999
        amountRupees: 999,
        aCoinReward: 1200,
        description: "1200 A-Coins Pack",
    },
    mystery_9_30: {
        id: "mystery_9_30",
        type: "pack",
        name: "Mystery Box 30 Ruby",
        amountInPaise: 900,
        amountRupees: 9,
        aCoinReward: 30,
        description: "30 Ruby - 7 Day Mystery Offer",
        mysteryBox: true,
    },
    mystery_19_50: {
        id: "mystery_19_50",
        type: "pack",
        name: "Mystery Box 50 Ruby",
        amountInPaise: 1900,
        amountRupees: 19,
        aCoinReward: 50,
        description: "50 Ruby - 7 Day Mystery Offer",
        mysteryBox: true,
    },
    mystery_49_80: {
        id: "mystery_49_80",
        type: "pack",
        name: "Mystery Box 80 Ruby",
        amountInPaise: 4900,
        amountRupees: 49,
        aCoinReward: 80,
        description: "80 Ruby - 7 Day Mystery Offer",
        mysteryBox: true,
    },
};

PRODUCTS.monthlyPlan = PRODUCTS.monthly;
PRODUCTS.yearlyPlan = PRODUCTS.yearly;

const VIDEO_COSTS = {
    10: { "720p": 12, "1080p": 15 },
    30: { "720p": 32, "1080p": 40 },
    50: { "720p": 56, "1080p": 70 },
    90: { "720p": 450, "1080p": 510, "1440p": 650 },
};

function getVideoCost(duration, quality) {
    const row = VIDEO_COSTS[duration];
    if (!row) return null;
    return Number(row[quality]) || null;
}

function getImageCost(imageCount, quality) {
    const base = {
        "720p": 12,
        "1080p": 18,
        "2K": 25,
        "4K": 35,
    }[quality];
    if (!base) return null;
    const count = Math.max(1, Math.min(4, Number(imageCount) || 1));
    return base + (count - 1) * 5;
}

function getProduct(productId) {
    return PRODUCTS[productId] || null;
}

const SUBSCRIPTION_PLAN_IDS = {
    monthly: process.env.RAZORPAY_MONTHLY_PLAN_ID || "",
    yearly: process.env.RAZORPAY_YEARLY_PLAN_ID || "",
};

function getSubscriptionPlanId(productId) {
    return SUBSCRIPTION_PLAN_IDS[productId] || null;
}

function getSubscriptionStartAt(product) {
    const start = new Date();

    if (product.trialDays) {
        start.setDate(start.getDate() + product.trialDays);
    } else if (product.renewalMonths) {
        start.setMonth(start.getMonth() + product.renewalMonths);
    }

    return Math.floor(start.getTime() / 1000);
}

function rupeesToPaise(rupees) {
    return Math.round(Number(rupees) * 100);
}

function safeEqualHex(a, b) {
    try {
        const aa = Buffer.from(String(a), "utf8");
        const bb = Buffer.from(String(b), "utf8");

        return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
    } catch (_) {
        return false;
    }
}

/*
 * --------------------------------------------------------------------------
 * Authentication Middleware
 * --------------------------------------------------------------------------
 */

async function requireFirebaseUser(req, res, next) {
    try {
        const header = req.headers.authorization || "";

        if (!header.startsWith("Bearer ")) {
            return res.status(401).json({
                success: false,
                error: "Unauthorized: Missing or invalid token format",
            });
        }

        const idToken = header.substring("Bearer ".length).trim();

        if (!idToken) {
            return res.status(401).json({
                success: false,
                error: "Unauthorized: Missing token",
            });
        }

        const decoded = await adminAuth.verifyIdToken(idToken);

        req.firebaseUser = decoded;
        req.user = decoded;
        req.uid = decoded.uid;

        next();
    } catch (error) {
        console.error("AUTH ERROR:", error.message || error);

        return res.status(401).json({
            success: false,
            error: "Unauthorized: Invalid or expired authentication token",
        });
    }
}

/*
 * --------------------------------------------------------------------------
 * Zenzy Direct Chat — Firebase Cloud Messaging (FCM)
 * --------------------------------------------------------------------------
 * These endpoints are used by the Android app for Instagram/Messenger-style
 * push notifications.
 *
 * - POST /register-fcm-token
 *     Saves the authenticated user's FCM token in users/{uid}.
 *
 * - POST /send-direct-message-notification
 *     Sends a push notification to the recipient after a direct-chat message
 *     is written to Firestore by the Android app.
 *
 * Invalid/expired FCM tokens are automatically removed.
 * The existing Razorpay, referral, subscription, video-request and update
 * systems are not changed by this section.
 * --------------------------------------------------------------------------
 */

function cleanFcmToken(value) {
    return typeof value === "string" ? value.trim() : "";
}

function normalizeFcmTokens(value) {
    if (!Array.isArray(value)) return [];

    return [...new Set(
        value
            .map(cleanFcmToken)
            .filter(Boolean)
    )].slice(0, 50);
}

async function getUserFcmTokens(uid) {
    if (!uid) return [];

    const userDoc = await db.collection("users").doc(uid).get();
    if (!userDoc.exists) return [];

    const data = userDoc.data() || {};
    return normalizeFcmTokens(data.fcmTokens);
}

async function removeFcmTokens(uid, tokensToRemove) {
    const removeSet = new Set(normalizeFcmTokens(tokensToRemove));
    if (!uid || removeSet.size === 0) return;

    const userRef = db.collection("users").doc(uid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return;

    const data = userDoc.data() || {};
    const currentTokens = normalizeFcmTokens(data.fcmTokens);
    const remainingTokens = currentTokens.filter(
        (token) => !removeSet.has(token)
    );

    await userRef.set(
        {
            fcmTokens: remainingTokens,
            updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
    );
}

app.post("/register-fcm-token", requireFirebaseUser, async (req, res) => {
    try {
        const uid = req.uid;
        const token = cleanFcmToken(req.body?.token);

        if (!token) {
            return res.status(400).json({
                success: false,
                message: "FCM token is required",
            });
        }

        const userRef = db.collection("users").doc(uid);
        const userDoc = await userRef.get();

        if (!userDoc.exists) {
            return res.status(404).json({
                success: false,
                message: "Zenzy user account not found",
            });
        }

        const data = userDoc.data() || {};
        const currentTokens = normalizeFcmTokens(data.fcmTokens);

        // Keep the newest token once, with a small safety cap for multi-device use.
        const nextTokens = [
            token,
            ...currentTokens.filter((item) => item !== token),
        ].slice(0, 50);

        await userRef.set(
            {
                fcmTokens: nextTokens,
                fcmTokenUpdatedAt: FieldValue.serverTimestamp(),
                updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
        );

        return res.status(200).json({
            success: true,
            message: "FCM token registered",
        });
    } catch (error) {
        console.error("REGISTER FCM TOKEN ERROR:", error);

        return res.status(500).json({
            success: false,
            message: "Could not register FCM token",
        });
    }
});

app.post(
    "/send-direct-message-notification",
    requireFirebaseUser,
    async (req, res) => {
        try {
            const senderUid = req.uid;
            const {
                receiverUid,
                senderName,
                messageType,
                messageText,
                conversationId,
            } = req.body || {};

            if (
                !receiverUid ||
                typeof receiverUid !== "string" ||
                receiverUid.trim() === ""
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Receiver UID is required",
                });
            }

            if (receiverUid === senderUid) {
                return res.status(400).json({
                    success: false,
                    message: "Cannot send a chat notification to yourself",
                });
            }

            // The sender may notify only the other participant of the exact
            // direct-chat conversation that contains both authenticated UIDs.
            if (typeof conversationId !== "string" || !conversationId.trim()) {
                return res.status(400).json({
                    success: false,
                    message: "Conversation ID is required",
                });
            }

            const conversationRef = db.collection("directChats").doc(conversationId.trim());
            const conversationDoc = await conversationRef.get();
            if (!conversationDoc.exists) {
                return res.status(404).json({
                    success: false,
                    message: "Direct chat conversation not found",
                });
            }

            const conversationData = conversationDoc.data() || {};
            const participantA = String(conversationData.userA || "");
            const participantB = String(conversationData.userB || "");
            const participantsMatch =
                (participantA === senderUid && participantB === receiverUid.trim()) ||
                (participantB === senderUid && participantA === receiverUid.trim());

            if (!participantsMatch) {
                return res.status(403).json({
                    success: false,
                    message: "You are not authorized to notify this conversation",
                });
            }

            // Verify the receiver exists before attempting FCM delivery.
            const receiverRef = db.collection("users").doc(receiverUid.trim());
            const receiverDoc = await receiverRef.get();

            if (!receiverDoc.exists) {
                return res.status(404).json({
                    success: false,
                    message: "Receiver account not found",
                });
            }

            const receiverData = receiverDoc.data() || {};
            const tokens = normalizeFcmTokens(receiverData.fcmTokens);

            if (tokens.length === 0) {
                return res.status(200).json({
                    success: true,
                    sent: 0,
                    message: "Receiver has no registered notification token",
                });
            }

            const cleanSenderName =
                typeof senderName === "string" && senderName.trim()
                    ? senderName.trim().slice(0, 80)
                    : "Zenzy User";

            const cleanType =
                typeof messageType === "string" && messageType.trim()
                    ? messageType.trim().slice(0, 30)
                    : "text";

            const rawText =
                typeof messageText === "string"
                    ? messageText.trim()
                    : "";

            let notificationBody = rawText;

            if (cleanType === "image") {
                notificationBody = "📷 Photo";
            } else if (cleanType === "file") {
                notificationBody = "📎 File";
            } else if (!notificationBody) {
                notificationBody = "New message";
            }

            notificationBody = notificationBody.slice(0, 180);

            const invalidTokens = [];
            let successCount = 0;
            let failureCount = 0;

            // Send individually for broad firebase-admin compatibility.
            for (const token of tokens) {
                try {
                    await getMessaging().send({
                        token,
                        notification: {
                            title: cleanSenderName,
                            body: notificationBody,
                        },
                        data: {
                            type: "direct_chat",
                            conversationId:
                                typeof conversationId === "string"
                                    ? conversationId.slice(0, 200)
                                    : "",
                            senderUid: senderUid,
                            receiverUid: receiverUid.trim(),
                            messageType: cleanType,
                        },
                        android: {
                            priority: "high",
                            notification: {
                                channelId: "zenzy_chat",
                                sound: "default",
                            },
                        },
                    });

                    successCount += 1;
                } catch (sendError) {
                    failureCount += 1;

                    const code = String(
                        sendError?.code || ""
                    ).toLowerCase();

                    if (
                        code.includes("registration-token-not-registered") ||
                        code.includes("invalid-registration-token") ||
                        code.includes("invalid-argument")
                    ) {
                        invalidTokens.push(token);
                    }

                    console.error(
                        "FCM DIRECT CHAT SEND ERROR:",
                        sendError?.message || sendError
                    );
                }
            }

            if (invalidTokens.length > 0) {
                try {
                    await removeFcmTokens(
                        receiverUid.trim(),
                        invalidTokens
                    );
                } catch (cleanupError) {
                    console.error(
                        "FCM INVALID TOKEN CLEANUP ERROR:",
                        cleanupError?.message || cleanupError
                    );
                }
            }

            return res.status(200).json({
                success: true,
                sent: successCount,
                failed: failureCount,
                removedInvalidTokens: invalidTokens.length,
            });
        } catch (error) {
            console.error(
                "SEND DIRECT MESSAGE NOTIFICATION ERROR:",
                error
            );

            return res.status(500).json({
                success: false,
                message: "Could not send direct chat notification",
            });
        }
    }
);

 /*
 * --------------------------------------------------------------------------
 * Health Check & API Routes
 * --------------------------------------------------------------------------
 */

app.get("/", (req, res) => {
    res.status(200).send("Zenzy Backend is Running");
});

/*
 * --------------------------------------------------------------------------
 * One-Time Coin Pack Order Creation (POST /create-order)
 * --------------------------------------------------------------------------
 */

/*
 * --------------------------------------------------------------------------
 * New User ₹29 / 100 Ruby Offer Status
 * GET /new-user-offer-status
 * --------------------------------------------------------------------------
 */
app.get("/new-user-offer-status", requireFirebaseUser, async (req, res) => {
    try {
        const uid = req.uid;
        const userDoc = await db.collection("users").doc(uid).get();
        const userData = userDoc.exists ? (userDoc.data() || {}) : {};

        const authUser = await adminAuth.getUser(uid);
        const accountCreatedAt = new Date(authUser.metadata.creationTime).getTime();
        const firstTimeOfferExpiresAt = accountCreatedAt + FIRST_TIME_OFFER_WINDOW_MS;
        const firstTimeOfferEligible =
            Date.now() < firstTimeOfferExpiresAt &&
            userData.firstTimeOfferClaimed !== true;

        const newUserOfferEligible =
            userData.newUserOfferEligible === true &&
            userData.newUserOfferClaimed !== true;

        return res.status(200).json({
            success: true,
            eligible: newUserOfferEligible,
            claimed: userData.newUserOfferClaimed === true,
            firstTimeOfferEligible,
            firstTimeOfferClaimed: userData.firstTimeOfferClaimed === true,
            firstTimeOfferExpiresAt,
        });
    } catch (error) {
        console.error("New User Offer Status Error:", error);
        return res.status(500).json({
            success: false,
            eligible: false,
            firstTimeOfferEligible: false,
            firstTimeOfferExpiresAt: 0,
            message: "Could not check new user offer status",
        });
    }
});


/*
 * --------------------------------------------------------------------------
 * Mystery Ruby Box — all users, 7-day server-controlled window
 * GET /mystery-box-status
 * --------------------------------------------------------------------------
 */
app.get("/mystery-box-status", requireFirebaseUser, async (req, res) => {
    try {
        const uid = req.uid;
        const userRef = db.collection("users").doc(uid);
        const userDoc = await userRef.get();
        if (!userDoc.exists) {
            return res.status(404).json({ success: false, message: "User profile not found" });
        }

        const userData = userDoc.data() || {};
        let startedAt = Number(userData.mysteryBoxStartedAtMs || 0);
        if (!startedAt) {
            startedAt = Date.now();
            await userRef.set(
                { mysteryBoxStartedAtMs: startedAt, mysteryBoxExpiresAtMs: startedAt + MYSTERY_BOX_WINDOW_MS },
                { merge: true }
            );
        }

        const expiresAt = Number(userData.mysteryBoxExpiresAtMs || (startedAt + MYSTERY_BOX_WINDOW_MS));
        return res.json({
            success: true,
            startedAt,
            expiresAt,
            expired: Date.now() >= expiresAt,
            claimed9: userData.mysteryBoxClaimed9 === true,
            claimed19: userData.mysteryBoxClaimed19 === true,
            claimed49: userData.mysteryBoxClaimed49 === true,
        });
    } catch (error) {
        console.error("Mystery Box Status Error:", error);
        return res.status(500).json({ success: false, message: "Could not load Mystery Box status" });
    }
});

/*
 * --------------------------------------------------------------------------
 * Referral Status (GET /referral-status)
 * --------------------------------------------------------------------------
 */
app.get("/referral-status", requireFirebaseUser, async (req, res) => {
    try {
        const uid = req.uid;
        const referralCode = await ensureReferralCode(uid);

        const userDoc = await db.collection("users").doc(uid).get();
        const userData = userDoc.data() || {};

        const referralsSnapshot = await db
            .collection("referrals")
            .where("referrerUid", "==", uid)
            .get();

        let invitedCount = 0;
        let firstPurchaseRewardedCount = 0;
        let totalEarned = 0;

        referralsSnapshot.forEach((doc) => {
            const data = doc.data() || {};
            invitedCount += 1;

            if (data.firstPurchaseRewarded === true) {
                firstPurchaseRewardedCount += 1;
            }

            totalEarned += Number(data.referrerRewardTotal || 0);
        });

        return res.status(200).json({
            success: true,
            referralCode,
            referralLink:
                `https://kairova7755.github.io/zenzy-website/?ref=${encodeURIComponent(referralCode)}`,
            invitedCount,
            firstPurchaseRewardedCount,
            totalEarned,
            referredBy: userData.referredBy || null,
            referralFirstPurchaseRewarded:
                userData.referralFirstPurchaseRewarded === true,
        });
    } catch (error) {
        console.error("Referral Status Error:", error);

        if (error.message === "USER_NOT_FOUND") {
            return res.status(404).json({
                success: false,
                message: "User profile not found",
            });
        }

        return res.status(500).json({
            success: false,
            message: "Could not load referral status",
        });
    }
});

/*
 * --------------------------------------------------------------------------
 * Attach Invite / Referral Code (POST /referral-attach)
 * --------------------------------------------------------------------------
 * Called after a newly created account opens a shared Zenzy invite.
 * The +50 Ruby signup reward is credited here, exactly once.
 * --------------------------------------------------------------------------
 */
app.post("/referral-attach", requireFirebaseUser, async (req, res) => {
    try {
        const uid = req.uid;
        const referralCode = cleanReferralCode(req.body?.referralCode);

        if (!referralCode) {
            return res.status(400).json({
                success: false,
                message: "Referral code is required",
            });
        }

        const referrerSnapshot = await db
            .collection("users")
            .where("referralCode", "==", referralCode)
            .limit(1)
            .get();

        if (referrerSnapshot.empty) {
            return res.status(404).json({
                success: false,
                message: "Referral code not found",
                code: "REFERRAL_CODE_NOT_FOUND",
            });
        }

        const referrerDoc = referrerSnapshot.docs[0];
        const referrerUid = referrerDoc.id;

        if (referrerUid === uid) {
            return res.status(400).json({
                success: false,
                message: "You cannot use your own referral code",
                code: "SELF_REFERRAL_NOT_ALLOWED",
            });
        }

        const userRef = db.collection("users").doc(uid);
        const referrerRef = db.collection("users").doc(referrerUid);
        const referralRef = db.collection("referrals").doc(uid);

        await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);

            if (!userDoc.exists) {
                throw new Error("USER_NOT_FOUND");
            }

            const existingReferralDoc = await transaction.get(referralRef);

            // Idempotent: if this account already has a referral attribution,
            // never award another signup reward.
            if (existingReferralDoc.exists) {
                throw new Error("REFERRAL_ALREADY_ATTACHED");
            }

            const userData = userDoc.data() || {};

            if (userData.referredBy) {
                throw new Error("REFERRAL_ALREADY_ATTACHED");
            }

            const referrerDocInTransaction = await transaction.get(referrerRef);

            if (!referrerDocInTransaction.exists) {
                throw new Error("REFERRER_NOT_FOUND");
            }

            const referrerData = referrerDocInTransaction.data() || {};
            const referrerCoins = Math.max(
                0,
                Number(referrerData.aCoins || referrerData.acoin || 0)
            );

            const friendCoins = Math.max(
                0,
                Number(userData.aCoins || userData.acoin || 0)
            );

            transaction.update(referrerRef, {
                aCoins: referrerCoins + REFERRAL_SIGNUP_REWARD,
                acoin: referrerCoins + REFERRAL_SIGNUP_REWARD,
                referralRubyEarned:
                    Number(referrerData.referralRubyEarned || 0) +
                    REFERRAL_SIGNUP_REWARD,
                updatedAt: FieldValue.serverTimestamp(),
            });

            transaction.set(
                userRef,
                {
                    referredBy: referrerUid,
                    referredByCode: referralCode,
                    referralSignupRewarded: true,
                    referralSignupRewardedAt: FieldValue.serverTimestamp(),
                    aCoins: friendCoins,
                    acoin: friendCoins,
                    updatedAt: FieldValue.serverTimestamp(),
                },
                { merge: true }
            );

            transaction.set(referralRef, {
                referrerUid,
                referredUid: uid,
                referralCode,
                signupRewarded: true,
                signupReward: REFERRAL_SIGNUP_REWARD,
                firstPurchaseRewarded: false,
                referrerRewardTotal: REFERRAL_SIGNUP_REWARD,
                friendRewardTotal: 0,
                createdAt: FieldValue.serverTimestamp(),
                updatedAt: FieldValue.serverTimestamp(),
            });

            const notificationRef = userRef
                .collection("notifications")
                .doc();

            transaction.set(notificationRef, {
                title: "Referral Joined",
                message: `Your friend invited you to Zenzy. Your referrer received ${REFERRAL_SIGNUP_REWARD} Ruby.`,
                type: "referral",
                createdAt: FieldValue.serverTimestamp(),
                read: false,
            });

            const referrerNotificationRef = referrerRef
                .collection("notifications")
                .doc();

            transaction.set(referrerNotificationRef, {
                title: "Friend Joined Zenzy",
                message: `Your friend joined using your invite. +${REFERRAL_SIGNUP_REWARD} Ruby added.`,
                type: "referral",
                createdAt: FieldValue.serverTimestamp(),
                read: false,
            });
        });

        return res.status(200).json({
            success: true,
            message: `Referral applied. ${REFERRAL_SIGNUP_REWARD} Ruby added to the referrer.`,
            referralCode,
            signupReward: REFERRAL_SIGNUP_REWARD,
        });
    } catch (error) {
        console.error("Referral Attach Error:", error);

        if (error.message === "USER_NOT_FOUND") {
            return res.status(404).json({
                success: false,
                message: "Zenzy user account not found",
            });
        }

        if (error.message === "REFERRER_NOT_FOUND") {
            return res.status(404).json({
                success: false,
                message: "Referral owner account not found",
            });
        }

        if (error.message === "REFERRAL_ALREADY_ATTACHED") {
            return res.status(409).json({
                success: false,
                message: "A referral has already been attached to this account",
                code: "REFERRAL_ALREADY_ATTACHED",
            });
        }

        return res.status(500).json({
            success: false,
            message: "Could not apply referral code",
        });
    }
});

app.post("/create-order", requireFirebaseUser, async (req, res) => {
    try {
        const { productId } = req.body || {};
const uid = req.uid;

const product = getProduct(productId);

        if (!productId || !product) {
            return res.status(400).json({ error: "Invalid product selected" });
        }

        if (product.type === "subscription") {
            return res.status(400).json({
                error: "Subscription products must be created via /create-subscription endpoint",
            });
        }

        // New-user offers are strictly one-time and server-controlled.
        if (productId === "new_user_100_ruby" || productId === "first_time_20_ruby") {
            const userDoc = await db.collection("users").doc(uid).get();

            if (!userDoc.exists) {
                return res.status(404).json({
                    success: false,
                    error: "User profile not found",
                });
            }

            const userData = userDoc.data() || {};

            if (productId === "new_user_100_ruby") {
                if (userData.newUserOfferEligible !== true) {
                    return res.status(403).json({
                        success: false,
                        error: "This new user offer is not available for this account",
                        code: "NEW_USER_OFFER_NOT_ELIGIBLE",
                    });
                }

                if (userData.newUserOfferClaimed === true) {
                    return res.status(409).json({
                        success: false,
                        error: "This new user offer has already been used",
                        code: "NEW_USER_OFFER_ALREADY_CLAIMED",
                    });
                }
            }

            if (product.mysteryBox === true) {
                const startedAt = Number(userData.mysteryBoxStartedAtMs || 0);
                const expiresAt = Number(userData.mysteryBoxExpiresAtMs || (startedAt + MYSTERY_BOX_WINDOW_MS));
                if (!startedAt || Date.now() >= expiresAt) {
                    return res.status(410).json({
                        success: false,
                        error: "This 7-day Mystery Ruby offer has expired",
                        code: "MYSTERY_BOX_EXPIRED",
                    });
                }
                const claimedField = productId === "mystery_9_30"
                    ? "mysteryBoxClaimed9"
                    : productId === "mystery_19_50"
                        ? "mysteryBoxClaimed19"
                        : "mysteryBoxClaimed49";
                if (userData[claimedField] === true) {
                    return res.status(409).json({
                        success: false,
                        error: "This Mystery Ruby offer has already been used",
                        code: "MYSTERY_BOX_ALREADY_CLAIMED",
                    });
                }
            }

            if (productId === "first_time_20_ruby") {
                const authUser = await adminAuth.getUser(uid);
                const accountCreatedAt = new Date(authUser.metadata.creationTime).getTime();
                const expiresAt = accountCreatedAt + FIRST_TIME_OFFER_WINDOW_MS;

                if (Date.now() >= expiresAt) {
                    return res.status(410).json({
                        success: false,
                        error: "The 12-hour first-time offer has expired",
                        code: "FIRST_TIME_OFFER_EXPIRED",
                    });
                }

                if (userData.firstTimeOfferClaimed === true) {
                    return res.status(409).json({
                        success: false,
                        error: "The first-time offer has already been used",
                        code: "FIRST_TIME_OFFER_ALREADY_CLAIMED",
                    });
                }
            }
        }

        const options = {
            amount: product.amountInPaise,
            currency: "INR",
            receipt: `rcpt_${uid.substring(0, 8)}_${Date.now()}`,
            notes: {
                uid: uid,
                productId: product.id,
            },
        };

        const order = await razorpay.orders.create(options);

        return res.status(200).json({
            id: order.id,
            orderId: order.id,
            keyId: process.env.RAZORPAY_KEY_ID,
            productName: product.description || product.name,
            entity: order.entity,
            amount: order.amount,
            amount_paid: order.amount_paid,
            amount_due: order.amount_due,
            currency: order.currency,
            receipt: order.receipt,
            status: order.status,
            attempts: order.attempts,
            notes: order.notes,
            created_at: order.created_at,
        });
    } catch (error) {
        console.error("Create Order Error:", error);
        return res.status(500).json({ error: "Failed to create order" });
    }
});

/*
 * --------------------------------------------------------------------------
 * Razorpay Premium Subscription Creation (POST /create-subscription)
 * --------------------------------------------------------------------------
 */
app.post("/create-subscription", requireFirebaseUser, async (req, res) => {
    try {
        const { productId } = req.body || {};
        const uid = req.uid;

        // Users may have both Monthly and Yearly Premium subscriptions.
        // The user decides which plans to purchase.
        const product = getProduct(productId);

        // Only Premium subscription products are allowed here.
        if (!productId || !product || product.type !== "subscription") {
            return res.status(400).json({
                success: false,
                error: "Invalid subscription product selected",
            });
        }

        // Get Razorpay Plan ID from environment variables.
        const planId = getSubscriptionPlanId(productId);

        if (!planId) {
            console.error(
                `Missing Razorpay plan ID for subscription product: ${productId}`
            );

            return res.status(500).json({
                success: false,
                error: "Subscription plan configuration missing on server",
            });
        }

        const startAt = getSubscriptionStartAt(product);

        const expireBy =
            Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;

        const subscriptionOptions = {
            plan_id: planId,

            total_count:
                productId === "monthly"
                    ? Number(process.env.RAZORPAY_MONTHLY_TOTAL_COUNT)
                    : Number(process.env.RAZORPAY_YEARLY_TOTAL_COUNT),

            quantity: 1,
            start_at: startAt,
            expire_by: expireBy,
            customer_notify: true,

            addons: [
                {
                    item: {
                        name: "Zenzy Premium Authorization",
                        amount: product.amountInPaise,
                        currency: "INR",
                    },
                },
            ],

            notes: {
                uid: uid,
                productId: product.id,
            },
        };

        const subscription =
            await razorpay.subscriptions.create(subscriptionOptions);

        if (!subscription || !subscription.id) {
            console.error(
                "Razorpay did not return a valid subscription ID:",
                subscription
            );

            return res.status(502).json({
                success: false,
                error: "Razorpay subscription creation failed",
            });
        }

        console.log(
            "ZENZY SUBSCRIPTION CREATED:",
            JSON.stringify({
                uid,
                productId,
                subscriptionId: subscription.id,
                planId,
                startAt,
                expireBy,
                status: subscription.status,
            })
        );

        return res.status(200).json({
            success: true,
            subscriptionId: subscription.id,
            keyId: process.env.RAZORPAY_KEY_ID,
            id: subscription.id,
            productId: product.id,
            productName: product.name,
            amount: product.amountInPaise,
            currency: "INR",
            status: subscription.status,
            trialEndsAt: startAt,
            planId: subscription.plan_id || planId,
            notes: subscription.notes || {
                uid,
                productId: product.id,
            },
        });
    } catch (error) {
        console.error(
            "Create Subscription Error:",
            error?.error?.description ||
                error?.message ||
                error
        );

        return res.status(500).json({
            success: false,
            error:
                error?.error?.description ||
                error?.message ||
                "Failed to create Razorpay subscription",
        });
    }
});

       

/*
 * --------------------------------------------------------------------------
 * Payment Verification (POST /verify-payment)
 * Handles both one-time orders and Razorpay subscriptions cleanly
 * --------------------------------------------------------------------------
 */
app.post("/verify-payment", requireFirebaseUser, async (req, res) => {
    try {
        const {
            razorpay_payment_id,
            razorpay_order_id,
            razorpay_subscription_id,
            razorpay_signature,
        } = req.body || {};

        const uid = req.uid;

        if (!razorpay_payment_id || !razorpay_signature) {
            return res.status(400).json({
                success: false,
                message: "Missing payment verification parameters",
            });
        }

        let isSubscriptionFlow = Boolean(razorpay_subscription_id);
        let productId = null;
        let product = null;

        if (isSubscriptionFlow) {
            // Verify Razorpay Subscription Signature: HMAC_SHA256(payment_id + "|" + subscription_id, secret)
            const expectedSignature = crypto
                .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
                .update(`${razorpay_payment_id}|${razorpay_subscription_id}`)
                .digest("hex");

            if (!safeEqualHex(expectedSignature, razorpay_signature)) {
                console.error("RAZORPAY SUBSCRIPTION SIGNATURE MISMATCH");
                return res.status(400).json({
                    success: false,
                    message: "Subscription payment signature verification failed",
                });
            }

            const subscription = await razorpay.subscriptions.fetch(razorpay_subscription_id);
            if (!subscription) {
                return res.status(404).json({
                    success: false,
                    message: "Razorpay subscription not found",
                });
            }

            const subUid = subscription.notes?.uid;
            productId = subscription.notes?.productId;

            if (!subUid || subUid !== uid) {
                return res.status(403).json({
                    success: false,
                    message: "Subscription does not belong to this account",
                });
            }

            product = getProduct(productId);
            if (!product) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid subscription product",
                });
            }

            const paymentRef = db.collection("payments").doc(razorpay_payment_id);
            const userRef = db.collection("users").doc(uid);
            const subscriptionRef = db.collection("subscriptions").doc(razorpay_subscription_id);

            const trialEndsTimestamp = Timestamp.fromMillis(
                (subscription.start_at || getSubscriptionStartAt(product)) * 1000
            );

            await db.runTransaction(async (transaction) => {
                const paymentDoc = await transaction.get(paymentRef);
                if (paymentDoc.exists) {
                    throw new Error("PAYMENT_ALREADY_PROCESSED");
                }

                const userDoc = await transaction.get(userRef);
                if (!userDoc.exists) {
                    throw new Error("USER_NOT_FOUND");
                }

               const userData = userDoc.data() || {};


const currentCoins = Math.max(
    0,
    Number(userData.aCoins || userData.acoin || 0)
);

                transaction.set(paymentRef, {
                    paymentId: razorpay_payment_id,
                    subscriptionId: razorpay_subscription_id,
                    uid: uid,
                    productId: productId,
                   amount: product.amountInPaise,
aCoinReward: 0,
type: "subscription_initial",
status: "captured",
                    createdAt: FieldValue.serverTimestamp(),
                });

                transaction.update(userRef, {
                    aCoins: currentCoins,
                    acoin: currentCoins,
                    isPremium: true,
                    plan: productId === "monthly" ? "MONTHLY" : "YEARLY",
                    subscriptionType: productId,
                    subscriptionStatus: subscription.status || "authenticated",
                    razorpaySubscriptionId: razorpay_subscription_id,
                    subscriptionStartDate: FieldValue.serverTimestamp(),
                    subscriptionStartAt: FieldValue.serverTimestamp(),
                    trialEndsAt: trialEndsTimestamp,
                    renewalAmount: product.renewalAmountRupees,
                    billingCycle: productId === "monthly" ? "monthly" : "yearly",
                    updatedAt: FieldValue.serverTimestamp(),
                });

                transaction.set(
                    subscriptionRef,
                    {
                        uid: uid,
                        productId: productId,
                        productName: product.name,
                        razorpaySubscriptionId: razorpay_subscription_id,
                        razorpayPlanId: subscription.plan_id,
                        status: subscription.status || "authenticated",
                        trialEndsAt: trialEndsTimestamp,
                        renewalAmountRupees: product.renewalAmountRupees,
                        updatedAt: FieldValue.serverTimestamp(),
                    },
                    { merge: true }
                );

                const notificationRef = db
                    .collection("users")
                    .doc(uid)
                    .collection("notifications")
                    .doc();

                transaction.set(notificationRef, {
                    title: "Premium Activated",
                   message: `Welcome to Zenzy Premium! Your ${product.name} trial has started. A-Coins will be credited only after the first successful renewal payment of ₹${product.renewalAmountRupees}.`,
                    type: "payment",
                    createdAt: FieldValue.serverTimestamp(),
                    read: false,
                });
            });

            return res.status(200).json({
                success: true,
                message: "Subscription verified successfully",
                subscriptionId: razorpay_subscription_id,
                productId: productId,
              aCoinReward: 0,
aCoinAwarded: 0,
            });
        }

        // Standard Order Flow (Coin Packs)
        if (!razorpay_order_id) {
            return res.status(400).json({
                success: false,
                message: "Missing order ID for standard payment verification",
            });
        }

        const order = await razorpay.orders.fetch(razorpay_order_id);
        if (!order) {
            return res.status(404).json({
                success: false,
                message: "Razorpay order not found",
            });
        }

        const orderUid = order.notes?.uid;
        productId = order.notes?.productId;

        if (!orderUid || !productId) {
            return res.status(400).json({
                success: false,
                message: "Payment order context is missing",
            });
        }

        if (orderUid !== uid) {
            return res.status(403).json({
                success: false,
                message: "Payment order does not belong to this account",
            });
        }

        product = getProduct(productId);
        if (!product) {
            return res.status(400).json({
                success: false,
                message: "Invalid payment product",
            });
        }

        const expectedSignature = crypto
            .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
            .update(`${order.id}|${razorpay_payment_id}`)
            .digest("hex");

        if (!safeEqualHex(expectedSignature, razorpay_signature)) {
            console.error("RAZORPAY PAYMENT SIGNATURE MISMATCH");
            return res.status(400).json({
                success: false,
                message: "Payment signature verification failed",
            });
        }

        const payment = await razorpay.payments.fetch(razorpay_payment_id);
        if (!payment) {
            return res.status(404).json({
                success: false,
                message: "Razorpay payment not found",
            });
        }

        if (payment.order_id !== order.id) {
            return res.status(400).json({
                success: false,
                message: "Payment and order mismatch",
            });
        }

        if (payment.status !== "captured" && payment.status !== "authorized") {
            return res.status(400).json({
                success: false,
                message: "Payment not completed",
            });
        }

        if (
            Number(order.amount) !== Number(product.amountInPaise) ||
            Number(payment.amount) !== Number(product.amountInPaise)
        ) {
            return res.status(400).json({
                success: false,
                message: "Payment amount mismatch",
            });
        }

        const paymentRef = db.collection("payments").doc(razorpay_payment_id);
        const userRef = db.collection("users").doc(uid);

        let referralFirstPurchaseRewarded = false;
        let referralReferrerUid = null;

        await db.runTransaction(async (transaction) => {
            const paymentDoc = await transaction.get(paymentRef);
            if (paymentDoc.exists) {
                throw new Error("PAYMENT_ALREADY_PROCESSED");
            }

            const userDoc = await transaction.get(userRef);
            if (!userDoc.exists) {
                throw new Error("USER_NOT_FOUND");
            }

            const userData = userDoc.data() || {};
            const currentCoins = Math.max(
                0,
                Number(userData.aCoins || userData.acoin || 0)
            );

            // Final server-side gate. Only the first verified payment can claim
            // each one-time new-user offer. The first-time ₹1 offer is also
            // checked against Firebase Auth account creation time.
            if (productId === "new_user_100_ruby") {
                if (userData.newUserOfferEligible !== true) {
                    throw new Error("NEW_USER_OFFER_NOT_ELIGIBLE");
                }

                if (userData.newUserOfferClaimed === true) {
                    throw new Error("NEW_USER_OFFER_ALREADY_CLAIMED");
                }
            }

            if (productId === "first_time_20_ruby") {
                const authUser = await adminAuth.getUser(uid);
                const accountCreatedAt = new Date(authUser.metadata.creationTime).getTime();
                const expiresAt = accountCreatedAt + FIRST_TIME_OFFER_WINDOW_MS;

                if (Date.now() >= expiresAt) {
                    throw new Error("FIRST_TIME_OFFER_EXPIRED");
                }

                if (userData.firstTimeOfferClaimed === true) {
                    throw new Error("FIRST_TIME_OFFER_ALREADY_CLAIMED");
                }
            }

            if (product.mysteryBox === true) {
                const startedAt = Number(userData.mysteryBoxStartedAtMs || 0);
                const expiresAt = Number(userData.mysteryBoxExpiresAtMs || (startedAt + MYSTERY_BOX_WINDOW_MS));
                if (!startedAt || Date.now() >= expiresAt) {
                    throw new Error("MYSTERY_BOX_EXPIRED");
                }
                const claimedField = productId === "mystery_9_30"
                    ? "mysteryBoxClaimed9"
                    : productId === "mystery_19_50"
                        ? "mysteryBoxClaimed19"
                        : "mysteryBoxClaimed49";
                if (userData[claimedField] === true) {
                    throw new Error("MYSTERY_BOX_ALREADY_CLAIMED");
                }
            }

            transaction.set(paymentRef, {
                paymentId: razorpay_payment_id,
                orderId: order.id,
                uid: uid,
                productId: productId,
                productName: product.name,
                amount: payment.amount,
                amountRupees: product.amountRupees,
                aCoinReward: product.aCoinReward,
                status: payment.status,
                type: productId === "first_time_20_ruby"
                    ? "first_time_offer"
                    : productId === "new_user_100_ruby"
                        ? "new_user_offer"
                        : "ruby_pack",
                createdAt: FieldValue.serverTimestamp(),
            });

            const updateData = {
                aCoins: currentCoins + product.aCoinReward,
                acoin: currentCoins + product.aCoinReward,
                updatedAt: FieldValue.serverTimestamp(),
            };

            if (productId === "new_user_100_ruby") {
                updateData.newUserOfferClaimed = true;
                updateData.newUserOfferClaimedAt = FieldValue.serverTimestamp();
            }

            if (productId === "first_time_20_ruby") {
                updateData.firstTimeOfferClaimed = true;
                updateData.firstTimeOfferClaimedAt = FieldValue.serverTimestamp();
            }

            if (product.mysteryBox === true) {
                if (productId === "mystery_9_30") {
                    updateData.mysteryBoxClaimed9 = true;
                    updateData.mysteryBoxClaimed9At = FieldValue.serverTimestamp();
                } else if (productId === "mystery_19_50") {
                    updateData.mysteryBoxClaimed19 = true;
                    updateData.mysteryBoxClaimed19At = FieldValue.serverTimestamp();
                } else if (productId === "mystery_49_80") {
                    updateData.mysteryBoxClaimed49 = true;
                    updateData.mysteryBoxClaimed49At = FieldValue.serverTimestamp();
                }
            }

            /*
             * Referral first-purchase reward:
             * Any successful Ruby pack/offer purchase counts, including
             * the ₹1 first-time Ruby offer and ₹29 new-user Ruby offer.
             * Premium subscriptions are never included.
             */
            if (
                product.type === "pack" &&
                userData.referredBy &&
                userData.referralFirstPurchaseRewarded !== true
            ) {
                const referralRef = db
                    .collection("referrals")
                    .doc(uid);

                const referralSnapshot = await transaction.get(referralRef);

                if (referralSnapshot.exists) {
                    const referralData = referralSnapshot.data() || {};
                    referralReferrerUid =
                        referralData.referrerUid || userData.referredBy;

                    if (
                        referralReferrerUid &&
                        referralReferrerUid !== uid &&
                        referralData.firstPurchaseRewarded !== true
                    ) {
                        const referrerRef = db
                            .collection("users")
                            .doc(referralReferrerUid);

                        const referrerSnapshot =
                            await transaction.get(referrerRef);

                        if (referrerSnapshot.exists) {
                            const referrerData =
                                referrerSnapshot.data() || {};

                            const referrerCoins = Math.max(
                                0,
                                Number(
                                    referrerData.aCoins ||
                                    referrerData.acoin ||
                                    0
                                )
                            );

                            updateData.aCoins +=
                                REFERRAL_FIRST_PURCHASE_FRIEND_REWARD;
                            updateData.acoin +=
                                REFERRAL_FIRST_PURCHASE_FRIEND_REWARD;
                            updateData.referralFirstPurchaseRewarded = true;
                            updateData.referralFirstPurchaseRewardedAt =
                                FieldValue.serverTimestamp();

                            transaction.update(referrerRef, {
                                aCoins:
                                    referrerCoins +
                                    REFERRAL_FIRST_PURCHASE_REFERRER_REWARD,
                                acoin:
                                    referrerCoins +
                                    REFERRAL_FIRST_PURCHASE_REFERRER_REWARD,
                                referralRubyEarned:
                                    Number(
                                        referrerData.referralRubyEarned || 0
                                    ) +
                                    REFERRAL_FIRST_PURCHASE_REFERRER_REWARD,
                                updatedAt: FieldValue.serverTimestamp(),
                            });

                            transaction.set(
                                referralRef,
                                {
                                    firstPurchaseRewarded: true,
                                    firstPurchaseProductId: productId,
                                    firstPurchasePaymentId:
                                        razorpay_payment_id,
                                    firstPurchaseRewardedAt:
                                        FieldValue.serverTimestamp(),
                                    referrerRewardTotal:
                                        Number(
                                            referralData.referrerRewardTotal ||
                                            0
                                        ) +
                                        REFERRAL_FIRST_PURCHASE_REFERRER_REWARD,
                                    friendRewardTotal:
                                        Number(
                                            referralData.friendRewardTotal ||
                                            0
                                        ) +
                                        REFERRAL_FIRST_PURCHASE_FRIEND_REWARD,
                                    updatedAt:
                                        FieldValue.serverTimestamp(),
                                },
                                { merge: true }
                            );

                            referralFirstPurchaseRewarded = true;

                            const referrerNotificationRef =
                                referrerRef
                                    .collection("notifications")
                                    .doc();

                            transaction.set(
                                referrerNotificationRef,
                                {
                                    title: "Referral Ruby Reward",
                                    message:
                                        `Your referred friend made their first Ruby purchase. +${REFERRAL_FIRST_PURCHASE_REFERRER_REWARD} Ruby added.`,
                                    type: "referral",
                                    createdAt:
                                        FieldValue.serverTimestamp(),
                                    read: false,
                                }
                            );
                        }
                    }
                }
            }

            transaction.update(userRef, updateData);

            const notificationRef = db
                .collection("users")
                .doc(uid)
                .collection("notifications")
                .doc();

            transaction.set(notificationRef, {
                title: "Payment Successful",
                message: referralFirstPurchaseRewarded
                    ? `You received ${product.aCoinReward} A-Coins for purchasing ${product.name || product.description}, plus ${REFERRAL_FIRST_PURCHASE_FRIEND_REWARD} Ruby referral bonus.`
                    : `You received ${product.aCoinReward} A-Coins for purchasing ${product.name || product.description}.`,
                type: "payment",
                createdAt: FieldValue.serverTimestamp(),
                read: false,
            });
        });

        return res.status(200).json({
            success: true,
            message: "Payment verified successfully",
            productId: productId,
            aCoinReward: product.aCoinReward,
            aCoinAwarded: product.aCoinReward,
            referralFriendReward:
                referralFirstPurchaseRewarded
                    ? REFERRAL_FIRST_PURCHASE_FRIEND_REWARD
                    : 0,
            referralReferrerReward:
                referralFirstPurchaseRewarded
                    ? REFERRAL_FIRST_PURCHASE_REFERRER_REWARD
                    : 0,
        });

    } catch (error) {
        console.error("Verify Payment Error:", error);

        if (error.message === "PAYMENT_ALREADY_PROCESSED") {
            return res.status(409).json({
                success: false,
                message: "Payment has already been processed",
            });
        }

        if (error.message === "MYSTERY_BOX_ALREADY_CLAIMED") {
            return res.status(409).json({
                success: false,
                message: "This Mystery Ruby offer has already been used",
                code: "MYSTERY_BOX_ALREADY_CLAIMED",
            });
        }

        if (error.message === "MYSTERY_BOX_EXPIRED") {
            return res.status(410).json({
                success: false,
                message: "This 7-day Mystery Ruby offer has expired",
                code: "MYSTERY_BOX_EXPIRED",
            });
        }

        if (error.message === "NEW_USER_OFFER_ALREADY_CLAIMED") {
            return res.status(409).json({
                success: false,
                message: "This new user offer has already been used",
                code: "NEW_USER_OFFER_ALREADY_CLAIMED",
            });
        }

        if (error.message === "FIRST_TIME_OFFER_ALREADY_CLAIMED") {
            return res.status(409).json({
                success: false,
                message: "The first-time offer has already been used",
                code: "FIRST_TIME_OFFER_ALREADY_CLAIMED",
            });
        }

        if (error.message === "FIRST_TIME_OFFER_EXPIRED") {
            return res.status(410).json({
                success: false,
                message: "The 12-hour first-time offer has expired",
                code: "FIRST_TIME_OFFER_EXPIRED",
            });
        }

        if (error.message === "NEW_USER_OFFER_NOT_ELIGIBLE") {
            return res.status(403).json({
                success: false,
                message: "This new user offer is not available for this account",
                code: "NEW_USER_OFFER_NOT_ELIGIBLE",
            });
        }

        if (error.message === "PREMIUM_ALREADY_ACTIVE") {
    return res.status(409).json({
        success: false,
        message:
            "Premium is already active for this account. This payment cannot activate another Premium plan.",
        code: "PREMIUM_ALREADY_ACTIVE",
    });
}

        if (error.message === "USER_NOT_FOUND") {
            return res.status(404).json({
                success: false,
                message: "User profile not found",
            });
        }

        return res.status(500).json({
            success: false,
            message: "Failed to process and verify payment",
        });
    }
});

/*
 * --------------------------------------------------------------------------
 * Get Transaction History (GET /my-transactions)
 * --------------------------------------------------------------------------
 */
app.get("/my-transactions", requireFirebaseUser, async (req, res) => {
    try {
        const uid = req.uid;

        const snapshot = await db
            .collection("payments")
            .where("uid", "==", uid)
            .get();

        const transactions = snapshot.docs.map((doc) => {
            const data = doc.data() || {};

            const productId = data.productId || "";
            const product = getProduct(productId);

            let transactionType = "RUBY";

            if (
                data.type === "subscription_initial" ||
                data.productType === "premium_renewal" ||
                data.subscriptionId ||
                data.razorpaySubscriptionId
            ) {
                transactionType = "PREMIUM";
            }

            const timestamp =
                data.createdAt ||
                data.processedAt ||
                null;

            let dateTimeMillis = null;

            if (timestamp && typeof timestamp.toMillis === "function") {
                dateTimeMillis = timestamp.toMillis();
            } else if (timestamp instanceof Date) {
                dateTimeMillis = timestamp.getTime();
            } else if (typeof timestamp === "number") {
                dateTimeMillis = timestamp;
            }

            const amountPaise =
                Number(
                    data.amountPaise ??
                    data.amount ??
                    0
                );

            const amountRupees =
                data.amountRupees != null
                    ? Number(data.amountRupees)
                    : amountPaise / 100;

            return {
                transactionId: doc.id,
                type: transactionType,
                productId: productId,
                productName:
                    data.productName ||
                    product?.name ||
                    product?.description ||
                    productId,

                amountRupees: amountRupees,
                amountPaise: amountPaise,

                aCoinReward:
                    Number(data.aCoinReward ?? product?.aCoinReward ?? 0),

                status:
                    data.status ||
                    data.paymentStatus ||
                    "captured",

                paymentId:
                    data.paymentId ||
                    data.razorpayPaymentId ||
                    "",

                orderId:
                    data.orderId ||
                    "",

                subscriptionId:
                    data.subscriptionId ||
                    data.razorpaySubscriptionId ||
                    "",

                dateTimeMillis: dateTimeMillis,
            };
        });

        transactions.sort((a, b) => {
            return (
                Number(b.dateTimeMillis || 0) -
                Number(a.dateTimeMillis || 0)
            );
        });

        return res.status(200).json({
            success: true,
            transactions,
        });
    } catch (error) {
        console.error("My Transactions Error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to load transaction history",
        });
    }
});

/*
 * --------------------------------------------------------------------------
 * Get All Premium Subscriptions (GET /my-subscriptions)
 * --------------------------------------------------------------------------
 */
app.get("/my-subscriptions", requireFirebaseUser, async (req, res) => {
    try {
        const uid = req.uid;

        const snapshot = await db
            .collection("subscriptions")
            .where("uid", "==", uid)
            .get();

        const subscriptions = snapshot.docs.map((doc) => {
            const data = doc.data() || {};

            return {
                subscriptionId:
                    data.razorpaySubscriptionId || doc.id,
                productId: data.productId || "",
                productName: data.productName || "",
                status: data.status || "",
                trialEndsAt: data.trialEndsAt || null,
                renewalAmountRupees:
                    data.renewalAmountRupees || null,
                cancelAtCycleEnd:
                    data.cancelAtCycleEnd === true,
                cancellationRequestedAt:
                    data.cancellationRequestedAt || null,
                paidCount:
                    data.paidCount ?? null,
                remainingCount:
                    data.remainingCount ?? null,
                updatedAt:
                    data.updatedAt || null,
            };
        });

        subscriptions.sort((a, b) => {
            const aTime =
                a.updatedAt?.toMillis?.() || 0;
            const bTime =
                b.updatedAt?.toMillis?.() || 0;

            return bTime - aTime;
        });

        return res.status(200).json({
            success: true,
            subscriptions,
        });
    } catch (error) {
        console.error("My Subscriptions Error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to load subscriptions",
        });
    }
});

/*
 * --------------------------------------------------------------------------
 * Cancel Subscription Endpoint (POST /cancel-subscription)
 * --------------------------------------------------------------------------
 */

/*
 * --------------------------------------------------------------------------
 * Cancel One Specific Premium Subscription
 * POST /cancel-subscription
 * --------------------------------------------------------------------------
 */
app.post("/cancel-subscription", requireFirebaseUser, async (req, res) => {
    try {
        const uid = req.uid;
        const { subscriptionId } = req.body || {};

        if (!subscriptionId || typeof subscriptionId !== "string") {
            return res.status(400).json({
                success: false,
                message: "Subscription ID is required",
            });
        }

        const subscriptionRef = db
            .collection("subscriptions")
            .doc(subscriptionId);

        const subscriptionDoc = await subscriptionRef.get();

        if (!subscriptionDoc.exists) {
            return res.status(404).json({
                success: false,
                message: "Subscription not found",
            });
        }

        const subscriptionData = subscriptionDoc.data() || {};

        if (subscriptionData.uid !== uid) {
            return res.status(403).json({
                success: false,
                message: "Subscription does not belong to this account",
            });
        }

        const currentStatus = String(
            subscriptionData.status || ""
        ).toLowerCase();

        if (
            ["cancelled", "completed", "expired"].includes(
                currentStatus
            )
        ) {
            return res.status(400).json({
                success: false,
                message: "This subscription is already inactive",
            });
        }

        let cancelledSubscription;

        try {
            cancelledSubscription =
                await razorpay.subscriptions.cancel(
                    subscriptionId,
                    true
                );
        } catch (rzpError) {
            console.error(
                "Razorpay Cancel Error:",
                rzpError?.error?.description ||
                    rzpError?.message ||
                    rzpError
            );

            return res.status(502).json({
                success: false,
                message:
                    rzpError?.error?.description ||
                    rzpError?.message ||
                    "Razorpay could not cancel this subscription",
            });
        }

        const now = FieldValue.serverTimestamp();

        await subscriptionRef.set(
            {
                status:
                    cancelledSubscription?.status ||
                    "cancelled",
                cancelAtCycleEnd: true,
                cancellationRequestedAt: now,
                updatedAt: now,
            },
            { merge: true }
        );

        return res.status(200).json({
            success: true,
            message:
                "Subscription cancellation scheduled successfully. Your current Premium period remains active and automatic renewal is stopped.",
            subscriptionId,
            productId: subscriptionData.productId || "",
            status:
                cancelledSubscription?.status ||
                "cancelled",
            cancelAtCycleEnd: true,
        });
    } catch (error) {
        console.error(
            "Cancel Subscription Error:",
            error
        );

        return res.status(500).json({
            success: false,
            message:
                error?.message ||
                "Failed to cancel subscription",
        });
    }
});

/*
 * --------------------------------------------------------------------------
 * Subscription Webhook Endpoint (POST /razorpay-webhook)
 * --------------------------------------------------------------------------
 */

app.post(
    "/razorpay-webhook",
    express.raw({ type: "application/json", limit: "2mb" }),
    async (req, res) => {
        try {
            const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || "";

            if (!webhookSecret) {
                console.error("RAZORPAY_WEBHOOK_SECRET is missing");
                return res.status(500).json({
                    success: false,
                    message: "Webhook secret is not configured",
                });
            }

            const signature = req.headers["x-razorpay-signature"];

            if (!signature || !Buffer.isBuffer(req.body)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid webhook request",
                });
            }

            const expectedSignature = crypto
                .createHmac("sha256", webhookSecret)
                .update(req.body)
                .digest("hex");


            if (!safeEqualHex(expectedSignature, signature)) {
                console.error("RAZORPAY WEBHOOK SIGNATURE MISMATCH");
                return res.status(400).json({
                    success: false,
                    message: "Invalid webhook signature",
                });
            }

            let event;

            try {
                event = JSON.parse(req.body.toString("utf8"));
            } catch (error) {
                console.error("RAZORPAY WEBHOOK JSON ERROR:", error.message);
                return res.status(400).json({
                    success: false,
                    message: "Invalid webhook JSON",
                });
            }

            const eventName = event.event || "";
            const subscriptionEntity = event.payload?.subscription?.entity || null;
            const paymentEntity = event.payload?.payment?.entity || null;

            if (!subscriptionEntity?.id) {
                return res.json({
                    success: true,
                    ignored: true,
                    message: "Webhook received without subscription data",
                });
            }

            const subscriptionId = subscriptionEntity.id;
            const subscriptionRef = db.collection("subscriptions").doc(subscriptionId);

            const existingSubscription = await subscriptionRef.get();
            const existingData = existingSubscription.exists
                ? existingSubscription.data() || {}
                : {};

            const notes = subscriptionEntity.notes || {};
            const uid = existingData.uid || notes.uid || null;
            const productId = existingData.productId || notes.productId || null;

            if (!uid || !productId) {
                console.error(
                    "WEBHOOK SUBSCRIPTION CONTEXT MISSING:",
                    subscriptionId
                );
                return res.status(400).json({
                    success: false,
                    message: "Subscription context missing",
                });
            }

            const product = getProduct(productId);

            if (!product) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid subscription product",
                });
            }

            const userRef = db.collection("users").doc(uid);

            if (eventName === "subscription.charged") {
                const paymentId = paymentEntity?.id;

                if (!paymentId) {
                    return res.status(400).json({
                        success: false,
                        message: "Subscription charged webhook has no payment ID",
                    });
                }

                const expectedRenewalAmount = rupeesToPaise(
                    product.renewalAmountRupees || product.amountRupees
                );

                const actualChargedAmount = Number(paymentEntity.amount || 0);

// Only a successful recurring renewal gets the Premium A-Coin reward.
// Never reward the initial ₹1 authorization.
if (actualChargedAmount !== expectedRenewalAmount) {
    console.log(
        "ZENZY SUBSCRIPTION CHARGE IGNORED (NOT RENEWAL):",
        JSON.stringify({
            uid,
            productId,
            subscriptionId,
            paymentId,
            actualChargedAmount,
            expectedRenewalAmount,
        })
    );

    return res.json({
        success: true,
        ignored: true,
        reason: "NOT_RENEWAL_CHARGE",
    });
}

                const paymentRef = db.collection("payments").doc(paymentId);

                await db.runTransaction(async (transaction) => {
                    const paymentSnapshot = await transaction.get(paymentRef);
                    if (paymentSnapshot.exists) {
                        return; // Idempotent check: Payment already recorded
                    }

                    const userSnapshot = await transaction.get(userRef);
                    if (!userSnapshot.exists) {
                        throw new Error("USER_NOT_FOUND");
                    }

                    const userData = userSnapshot.data() || {};
                    const currentCoins = Math.max(
                        0,
                        Number(userData.aCoins || userData.acoin || 0)
                    );

                    const paymentRecord = {
                        uid,
                        productId,
                        productType: "premium_renewal",
                        productName: product.name,
                        amountRupees: product.renewalAmountRupees || product.amountRupees,
                        amountPaise: paymentEntity.amount || expectedRenewalAmount,
                        aCoinReward: product.aCoinReward,
                        razorpayPaymentId: paymentId,
                        razorpaySubscriptionId: subscriptionId,
                        paymentStatus: paymentEntity.status || "captured",
                        processedAt: FieldValue.serverTimestamp(),
                    };

                    transaction.set(
                        userRef,
                        {
                            aCoins: currentCoins + product.aCoinReward,
                            acoin: currentCoins + product.aCoinReward,
                            isPremium: true,
                            plan: productId === "monthly" ? "MONTHLY" : "YEARLY",
                            subscriptionStatus: "active",
                            updatedAt: FieldValue.serverTimestamp(),
                        },
                        { merge: true }
                    );

                    transaction.set(paymentRef, paymentRecord);

                    transaction.set(
                        subscriptionRef,
                        {
                            uid,
                            productId,
                            productName: product.name,
                            razorpaySubscriptionId: subscriptionId,
                            razorpayPlanId:
                                subscriptionEntity.plan_id ||
                                existingData.razorpayPlanId ||
                                null,
                            status: subscriptionEntity.status || "active",
                            paidCount: subscriptionEntity.paid_count ?? null,
                            remainingCount: subscriptionEntity.remaining_count ?? null,
                            lastPaymentId: paymentId,
                            lastRenewalAmountRupees:
                                product.renewalAmountRupees || product.amountRupees,
                            updatedAt: FieldValue.serverTimestamp(),
                        },
                        { merge: true }
                    );
                });

                return res.json({
                    success: true,
                    message: "Subscription renewal processed",
                });
            }

            const subscriptionStatus = subscriptionEntity.status || null;

            const update = {
                uid,
                productId,
                productName: product.name,
                razorpaySubscriptionId: subscriptionId,
                status: subscriptionStatus,
                updatedAt: FieldValue.serverTimestamp(),
            };

            if (
    eventName === "subscription.cancelled" ||
    eventName === "subscription.completed" ||
    eventName === "subscription.expired"
) {
    update.status = subscriptionStatus;

    const activeSubscriptionsSnapshot = await db
        .collection("subscriptions")
        .where("uid", "==", uid)
        .get();

    const hasAnotherActiveSubscription =
        activeSubscriptionsSnapshot.docs.some((doc) => {
            if (doc.id === subscriptionId) {
                return false;
            }

            const data = doc.data() || {};
            const status = String(
                data.status || ""
            ).toLowerCase();

            return [
                "active",
                "authenticated",
                "pending",
            ].includes(status);
        });

    if (!hasAnotherActiveSubscription) {
        await userRef.set(
            {
                isPremium: false,
                plan: "FREE",
                subscriptionStatus: subscriptionStatus,
                updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
        );
    }
}

            await subscriptionRef.set(update, { merge: true });

            return res.json({
                success: true,
                processed: true,
                event: eventName,
            });
        } catch (error) {
            console.error("RAZORPAY WEBHOOK ERROR:", error);
            return res.status(500).json({
                success: false,
                message: "Webhook processing failed",
            });
        }
    }
);

/*
 * --------------------------------------------------------------------------
 * App Listener
 * --------------------------------------------------------------------------
 */
/*
 * --------------------------------------------------------------------------
 * Secure Video Request + A-Coin Deduction
 * POST /create-video-request
 * --------------------------------------------------------------------------
 */

app.post(
    "/create-video-request",
    requireFirebaseUser,
    async (req, res) => {
        try {
            const body = req.body || {};

            const {
                name,
                mobile,
                description,
                plan,
                photoUrl,
                photoUrls,
                photoCount,
                photoSelected,
                generationMode,
                videoDurationSeconds,
                aCoinCost,
                quality,
                aspectRatio,
                videoStyle,
                imageStyle,
                createdAt,
                requestDate,
            } = body;

            const duration = Number(videoDurationSeconds || 0);
            const requestedMode = typeof generationMode === "string"
                ? generationMode.toUpperCase()
                : "IMAGE";

            const normalizedQuality = typeof quality === "string" ? quality.trim() : "1080p";
            const urlsForPricing = Array.isArray(photoUrls)
                ? photoUrls.filter((url) => typeof url === "string" && url.trim().length > 0)
                : [];

            let expectedCost = null;
            if (requestedMode === "CHARACTER") {
                if (urlsForPricing.length < 1 || urlsForPricing.length > 4) {
                    return res.status(400).json({
                        success: false,
                        message: "Create Image supports 1 to 4 images",
                    });
                }
                expectedCost = getImageCost(urlsForPricing.length, normalizedQuality);
                if (!expectedCost) {
                    return res.status(400).json({
                        success: false,
                        message: "Invalid image quality selected",
                    });
                }
            } else {
                expectedCost = getVideoCost(duration, normalizedQuality);
                if (!expectedCost) {
                    return res.status(400).json({
                        success: false,
                        message: "Invalid video duration or quality selected",
                    });
                }
                if (duration !== 90 && normalizedQuality === "1440p") {
                    return res.status(400).json({
                        success: false,
                        message: "1440p is available only for 90-second videos",
                    });
                }
            }

            if (Number(aCoinCost) !== expectedCost) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid A-Coin cost",
                });
            }

            // Validate uploaded photos
            const urls = Array.isArray(photoUrls)
                ? photoUrls.filter(
                      (url) =>
                          typeof url === "string" &&
                          url.trim().length > 0
                  )
                : [];

            const mode = requestedMode === "TEXT"
                ? "TEXT"
                : requestedMode === "CHARACTER"
                    ? "CHARACTER"
                    : "IMAGE";

            if (
                (mode === "IMAGE" && (urls.length < 1 || urls.length > 5)) ||
                (mode === "CHARACTER" && (urls.length < 1 || urls.length > 4))
            ) {
                return res.status(400).json({
                    success: false,
                    message: mode === "CHARACTER"
                        ? "Please provide 1 to 4 images for Create Image"
                        : "Please provide 1 to 5 uploaded photos",
                });
            }

if (
    mode === "TEXT" &&
    (!description || !String(description).trim())
) {
    return res.status(400).json({
        success: false,
        message: "Please provide a text prompt for Text-to-Video mode",
    });
}

            const uid = req.uid;

            const userRef = db
                .collection("users")
                .doc(uid);

            const requestRef = db
                .collection("videoRequests")
                .doc();

            let remainingCoins = 0;

            // Atomically check balance + deduct A-Coins + create request
            await db.runTransaction(async (transaction) => {

                const userSnapshot =
                    await transaction.get(userRef);

                if (!userSnapshot.exists) {
                    throw new Error("USER_NOT_FOUND");
                }

                const userData =
                    userSnapshot.data() || {};

                const currentCoins = Math.max(
                    0,
                    Number(
                        userData.aCoins ||
                        userData.acoin ||
                        0
                    )
                );

                if (currentCoins < expectedCost) {
                    throw new Error(
                        "INSUFFICIENT_A_COINS"
                    );
                }

                remainingCoins =
                    currentCoins - expectedCost;

                // Deduct A-Coins
                transaction.set(
                    userRef,
                    {
                        aCoins: remainingCoins,
                        acoin: remainingCoins,
                        updatedAt:
                            FieldValue.serverTimestamp(),
                    },
                    {
                        merge: true,
                    }
                );

                // Create video request
                transaction.set(
                    requestRef,
                    {
                        id: requestRef.id,
                        uid: uid,

                        name:
                            typeof name === "string"
                                ? name
                                : "",

                        mobile:
                            typeof mobile === "string"
                                ? mobile
                                : uid,

                        description:
                            typeof description === "string"
                                ? description.trim()
                                : "",

                        plan:
                            typeof plan === "string"
                                ? plan
                                : "FREE",

                        photoUrl:
    mode === "IMAGE" &&
    typeof photoUrl === "string" &&
    photoUrl.trim()
        ? photoUrl
        : (mode === "IMAGE" ? urls[0] : ""),

                        photoUrls: urls,

                        generationMode: mode,

                        photoCount:
    mode === "IMAGE"
        ? (Number(photoCount) || urls.length)
        : 0,

                       photoSelected:
    mode === "IMAGE",

                        videoDurationSeconds:
                            duration,

                        aCoinCost:
                            expectedCost,

                        quality: normalizedQuality,
                        aspectRatio:
                            typeof aspectRatio === "string" ? aspectRatio : "9:16",
                        videoStyle:
                            typeof videoStyle === "string" ? videoStyle : "Auto",
                        imageStyle:
                            typeof imageStyle === "string" ? imageStyle : "Realistic",

                        status: "Pending",

                        createdAt:
                            typeof createdAt === "string"
                                ? createdAt
                                : new Date().toISOString(),

                        requestDate:
                            typeof requestDate === "string"
                                ? requestDate
                                : new Date()
                                      .toISOString()
                                      .slice(0, 10),

                        submittedAt:
                            FieldValue.serverTimestamp(),

                        updatedAt:
                            FieldValue.serverTimestamp(),
                    }
                );
            });

            return res.status(200).json({
                success: true,
                message:
                    "Video generation request submitted successfully",

                requestId:
                    requestRef.id,

                deductedCoins:
                    expectedCost,

                remainingCoins:
                    remainingCoins,

                aCoinCost:
                    expectedCost,
            });

        } catch (error) {

            console.error(
                "CREATE VIDEO REQUEST ERROR:",
                error
            );

            if (error.message === "USER_NOT_FOUND") {
                return res.status(404).json({
                    success: false,
                    message:
                        "Zenzy user account not found",
                });
            }

            if (
                error.message ===
                "INSUFFICIENT_A_COINS"
            ) {
                return res.status(409).json({
                    success: false,
                    message:
                        "Insufficient A-Coin balance",
                });
            }

            return res.status(500).json({
                success: false,
                message:
                    "Video request could not be created",
            });
        }
    }
);


/*
 * --------------------------------------------------------------------------
 * Zenzy App Forced Update
 * GET /app-version
 * --------------------------------------------------------------------------
 * The Android app checks this endpoint before opening the main app.
 * Change only these values when releasing a newer APK.
 */
app.get("/app-version", (req, res) => {
    // FUTURE RELEASES:
    // Only change these Render environment variables:
    // ZENZY_LATEST_VERSION_CODE = new Android versionCode
    // ZENZY_MINIMUM_VERSION_CODE = same value for a mandatory update
    // ZENZY_LATEST_VERSION_NAME = e.g. 1.2
    // ZENZY_APK_DOWNLOAD_URL = direct HTTPS URL of the new APK
    const latestVersionCode = Number(
        process.env.ZENZY_LATEST_VERSION_CODE || 4
    );
    const minimumVersionCode = Number(
        process.env.ZENZY_MINIMUM_VERSION_CODE || latestVersionCode
    );
    const latestVersionName =
        process.env.ZENZY_LATEST_VERSION_NAME || "1.3";
    const downloadUrl =
        process.env.ZENZY_APK_DOWNLOAD_URL ||
        "https://github.com/Kairova7755/zenzy-website/releases/latest/download/ZenzyFlow.apk";

    const forceUpdate = minimumVersionCode >= latestVersionCode;

    return res.status(200).json({
        success: true,
        forceUpdate,
        latestVersionCode,
        minimumVersionCode,
        latestVersionName,
        downloadUrl,
        releaseNotes:
            process.env.ZENZY_RELEASE_NOTES ||
            "New Zenzy Flow update is available.",
    });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

