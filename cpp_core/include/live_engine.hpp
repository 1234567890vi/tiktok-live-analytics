#pragma once
// =============================================================================
//  live_engine.hpp — TikTok Live Analytics C++17 Core Engine
//  Thread-safe, high-performance state management for real-time stream data.
// =============================================================================

#include <algorithm>
#include <chrono>
#include <deque>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace tiktok {

// ---------------------------------------------------------------------------
// Data Transfer Structures
// ---------------------------------------------------------------------------

/** A single supporter / gifter record, ranked by total diamonds. */
struct Supporter {
    std::string user_id;
    std::string unique_id;    ///< @handle
    std::string nickname;
    std::string avatar_url;
    int64_t     total_diamonds = 0;
    int64_t     gift_count     = 0;  ///< number of distinct gift events

    bool operator>(const Supporter& rhs) const {
        return total_diamonds > rhs.total_diamonds;
    }
};

/** Single comment record stored in the circular buffer. */
struct CommentItem {
    std::string user_id;
    std::string unique_id;
    std::string nickname;
    std::string avatar_url;
    std::string comment_text;
    int64_t     timestamp_ms = 0;  ///< epoch milliseconds
    int32_t     user_level   = 0;
};

/** Represents one settled gift transaction (after streak finalisation). */
struct GiftTransaction {
    std::string gift_id;
    std::string gift_name;
    std::string gift_icon_url;
    int64_t     diamond_unit_cost = 0;
    int32_t     repeat_count      = 1;
    bool        is_streak_ending  = false;
    int64_t     total_value       = 0;  ///< diamond_unit_cost * delta_repeat
};

/** A single user's like contribution. */
struct LikerRecord {
    std::string user_id;
    std::string unique_id;
    std::string nickname;
    std::string avatar_url;
    int64_t     like_count = 0;

    bool operator>(const LikerRecord& rhs) const {
        return like_count > rhs.like_count;
    }
};

/** PK Battle round state snapshot. */
struct PKRoundState {
    bool        is_active        = false;
    std::string battle_id;
    std::string host_username;
    std::string opponent_username;
    int64_t     host_points      = 0;
    int64_t     opponent_points  = 0;
    int32_t     host_wins        = 0;
    int32_t     opponent_wins    = 0;
    int32_t     round_number     = 1;
};

/** Full dashboard snapshot — cheap to copy, ready for JSON serialisation. */
struct DashboardSnapshot {
    // Engagement
    int64_t total_likes      = 0;
    double  likes_per_second = 0.0;
    int64_t viewer_count     = 0;

    // Gifts / Revenue
    int64_t total_diamonds   = 0;
    double  estimated_usd    = 0.0;   ///< diamonds * 0.005
    double  net_payout_usd   = 0.0;   ///< estimated_usd * 0.50

    // Comments
    int32_t total_comments   = 0;

    // PK
    PKRoundState pk_state;

    // Leaderboards (top 10)
    std::vector<Supporter>   top_supporters;
    std::vector<LikerRecord> top_likers;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
namespace detail {

/** Rolling window accumulator for LPS calculation. */
struct LikeWindow {
    using Clock = std::chrono::steady_clock;
    using TP    = Clock::time_point;

    struct Entry { TP ts; int64_t count; };

    static constexpr double WINDOW_SECS = 5.0;
    std::deque<Entry> entries;

    void push(int64_t delta) {
        auto now = Clock::now();
        entries.push_back({now, delta});
        // Evict entries older than WINDOW_SECS
        while (!entries.empty()) {
            double age = std::chrono::duration<double>(now - entries.front().ts).count();
            if (age > WINDOW_SECS) entries.pop_front();
            else break;
        }
    }

    double lps() const {
        if (entries.empty()) return 0.0;
        auto now = Clock::now();
        double window = std::min(
            std::chrono::duration<double>(now - entries.front().ts).count(),
            WINDOW_SECS
        );
        if (window <= 0.0) return 0.0;
        int64_t total = 0;
        for (const auto& e : entries) total += e.count;
        return static_cast<double>(total) / window;
    }
};

}  // namespace detail

// ---------------------------------------------------------------------------
// LiveRoomEngine — primary interface exposed to Python
// ---------------------------------------------------------------------------

/**
 * Thread-safe analytics engine for a single TikTok Live room session.
 * All public methods acquire the internal mutex and are safe to call from
 * any thread (e.g., asyncio event loop via pybind11 GIL-released calls).
 *
 * NOTE: std::mutex is neither copyable nor movable, therefore LiveRoomEngine
 * explicitly deletes all copy AND move operations. Use via unique_ptr or
 * in-place if heap allocation of the engine is needed.
 */
class LiveRoomEngine {
public:
    static constexpr size_t COMMENT_BUFFER_SIZE = 200;

    explicit LiveRoomEngine(std::string host_username = "");
    ~LiveRoomEngine() = default;

    // Non-copyable, non-movable (std::mutex cannot be moved)
    LiveRoomEngine(const LiveRoomEngine&)            = delete;
    LiveRoomEngine& operator=(const LiveRoomEngine&) = delete;
    LiveRoomEngine(LiveRoomEngine&&)                 = delete;
    LiveRoomEngine& operator=(LiveRoomEngine&&)      = delete;

    // ------------------------------------------------------------------
    // Event processors
    // ------------------------------------------------------------------

    /**
     * Process an incoming like event.
     * @param user_id          Sender TikTok user_id string
     * @param unique_id        Sender @handle
     * @param nickname         Display name
     * @param avatar_url       Profile picture URL
     * @param like_count       Number of likes in THIS event
     * @param total_room_likes Authoritative server total (may jump)
     * @return current total_likes after update
     */
    int64_t process_like(
        const std::string& user_id,
        const std::string& unique_id,
        const std::string& nickname,
        const std::string& avatar_url,
        int64_t            like_count,
        int64_t            total_room_likes
    );

    /**
     * Process an incoming comment event.
     * Adds to the circular buffer (max COMMENT_BUFFER_SIZE entries).
     * @return a copy of the stored CommentItem
     */
    CommentItem process_comment(
        const std::string& user_id,
        const std::string& unique_id,
        const std::string& nickname,
        const std::string& avatar_url,
        const std::string& text,
        int64_t            timestamp_ms,
        int32_t            user_level = 0
    );

    /**
     * Process an incoming gift event with full streak/combo handling.
     * CRITICAL: When streak_active==true the method only adds the *delta*
     * (new_repeat - previous_repeat) * unit_diamonds to avoid double-counting.
     * When streak_active==false the streak key is finalised and cleared.
     * @return the settled GiftTransaction for this call
     */
    GiftTransaction process_gift(
        const std::string& user_id,
        const std::string& unique_id,
        const std::string& nickname,
        const std::string& avatar_url,
        const std::string& gift_id,
        const std::string& gift_name,
        const std::string& gift_icon,
        int64_t            unit_diamonds,
        int32_t            repeat_count,
        bool               streak_active
    );

    /**
     * Update PK battle state from LinkMicBattle / LinkMicArmies events.
     * Automatically increments win counters when a battle transitions
     * from active → ended.
     */
    void update_pk_battle(
        const std::string& battle_id,
        bool               is_active,
        const std::string& host_name,
        const std::string& opponent_name,
        int64_t            host_score,
        int64_t            opponent_score
    );

    /** Update the live viewer count. */
    void update_viewer_count(int64_t count);

    // ------------------------------------------------------------------
    // Queries
    // ------------------------------------------------------------------

    /** Top N gifters sorted descending by total_diamonds (partial_sort). */
    std::vector<Supporter> get_top_supporters(int limit = 10) const;

    /** Top N likers sorted descending by like_count. */
    std::vector<LikerRecord> get_top_likers(int limit = 10) const;

    /** Last M comments from the circular buffer (most recent last). */
    std::vector<CommentItem> get_recent_comments(int limit = 50) const;

    /** Returns a full, self-consistent dashboard snapshot. */
    DashboardSnapshot get_dashboard_snapshot() const;

    /** Current PK state snapshot. */
    PKRoundState get_pk_state() const;

    /** Current Likes-Per-Second (rolling 5-second window). */
    double get_lps() const;

    /** Total accumulated diamonds for this session. */
    int64_t get_total_diamonds() const;

    /** Total likes seen this session. */
    int64_t get_total_likes() const;

    /** Total comment count. */
    int32_t get_total_comments() const;

    /** Reset all state (new session). */
    void reset();

private:
    mutable std::mutex mutex_;

    // Host info
    std::string host_username_;

    // Likes
    int64_t total_likes_ = 0;
    std::unordered_map<std::string, LikerRecord> likers_;
    detail::LikeWindow like_window_;

    // Comments
    std::deque<CommentItem> comment_buffer_;  ///< acts as circular buffer
    int32_t total_comments_ = 0;

    // Gifts
    int64_t total_diamonds_ = 0;
    std::unordered_map<std::string, Supporter>  supporters_;     ///< key: user_id
    std::unordered_map<std::string, int32_t>    active_streaks_; ///< key: user_id_giftid

    // PK
    PKRoundState pk_state_;

    // Viewers
    int64_t viewer_count_ = 0;

    // Internal helpers (called only while mutex_ is already held)
    Supporter& get_or_create_supporter(
        const std::string& user_id,
        const std::string& unique_id,
        const std::string& nickname,
        const std::string& avatar_url
    );

    LikerRecord& get_or_create_liker(
        const std::string& user_id,
        const std::string& unique_id,
        const std::string& nickname,
        const std::string& avatar_url
    );
};

}  // namespace tiktok
