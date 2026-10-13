// =============================================================================
//  live_engine.cpp — TikTok Live Analytics C++17 Core Engine Implementation
// =============================================================================

#include "live_engine.hpp"
#include <algorithm>
#include <cassert>
#include <chrono>
#include <stdexcept>

namespace tiktok {

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

LiveRoomEngine::LiveRoomEngine(std::string host_username)
    : host_username_(std::move(host_username)) {}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

Supporter& LiveRoomEngine::get_or_create_supporter(
    const std::string& user_id,
    const std::string& unique_id,
    const std::string& nickname,
    const std::string& avatar_url)
{
    auto it = supporters_.find(user_id);
    if (it == supporters_.end()) {
        Supporter s;
        s.user_id    = user_id;
        s.unique_id  = unique_id;
        s.nickname   = nickname;
        s.avatar_url = avatar_url;
        auto [ins, ok] = supporters_.emplace(user_id, std::move(s));
        return ins->second;
    }
    // Update mutable fields if they changed (avatar rotations, name changes)
    it->second.nickname   = nickname;
    it->second.avatar_url = avatar_url;
    return it->second;
}

LikerRecord& LiveRoomEngine::get_or_create_liker(
    const std::string& user_id,
    const std::string& unique_id,
    const std::string& nickname,
    const std::string& avatar_url)
{
    auto it = likers_.find(user_id);
    if (it == likers_.end()) {
        LikerRecord r;
        r.user_id    = user_id;
        r.unique_id  = unique_id;
        r.nickname   = nickname;
        r.avatar_url = avatar_url;
        auto [ins, ok] = likers_.emplace(user_id, std::move(r));
        return ins->second;
    }
    it->second.nickname   = nickname;
    it->second.avatar_url = avatar_url;
    return it->second;
}

// ---------------------------------------------------------------------------
// process_like
// ---------------------------------------------------------------------------

int64_t LiveRoomEngine::process_like(
    const std::string& user_id,
    const std::string& unique_id,
    const std::string& nickname,
    const std::string& avatar_url,
    int64_t            like_count,
    int64_t            total_room_likes)
{
    std::lock_guard<std::mutex> lock(mutex_);

    // The authoritative server total can jump ahead due to missed events.
    // We take the maximum to never go backwards.
    int64_t prev_total = total_likes_;
    total_likes_ = std::max(total_likes_, total_room_likes);

    // Delta to add to per-user count: conservatively the like_count event.
    int64_t delta = like_count > 0 ? like_count : (total_likes_ - prev_total);
    if (delta < 0) delta = 0;

    // Per-user accumulation
    auto& rec     = get_or_create_liker(user_id, unique_id, nickname, avatar_url);
    rec.like_count += delta;

    // Rolling LPS window
    if (delta > 0) like_window_.push(delta);

    return total_likes_;
}

// ---------------------------------------------------------------------------
// process_comment
// ---------------------------------------------------------------------------

CommentItem LiveRoomEngine::process_comment(
    const std::string& user_id,
    const std::string& unique_id,
    const std::string& nickname,
    const std::string& avatar_url,
    const std::string& text,
    int64_t            timestamp_ms,
    int32_t            user_level)
{
    std::lock_guard<std::mutex> lock(mutex_);

    CommentItem item;
    item.user_id      = user_id;
    item.unique_id    = unique_id;
    item.nickname     = nickname;
    item.avatar_url   = avatar_url;
    item.comment_text = text;
    item.timestamp_ms = timestamp_ms;
    item.user_level   = user_level;

    // Circular buffer: evict oldest when full
    if (comment_buffer_.size() >= COMMENT_BUFFER_SIZE) {
        comment_buffer_.pop_front();
    }
    comment_buffer_.push_back(item);
    ++total_comments_;

    return item;
}

// ---------------------------------------------------------------------------
// process_gift  — CRITICAL streak/combo deduplication logic
// ---------------------------------------------------------------------------

GiftTransaction LiveRoomEngine::process_gift(
    const std::string& user_id,
    const std::string& unique_id,
    const std::string& nickname,
    const std::string& avatar_url,
    const std::string& gift_id,
    const std::string& gift_name,
    const std::string& gift_icon,
    int64_t            unit_diamonds,
    int32_t            repeat_count,
    bool               streak_active)
{
    std::lock_guard<std::mutex> lock(mutex_);

    // Streak key: uniquely identifies an ongoing combo for this (user, gift)
    const std::string streak_key = user_id + "_" + gift_id;

    GiftTransaction txn;
    txn.gift_id         = gift_id;
    txn.gift_name       = gift_name;
    txn.gift_icon_url   = gift_icon;
    txn.diamond_unit_cost = unit_diamonds;
    txn.repeat_count    = repeat_count;
    txn.is_streak_ending = !streak_active;

    int32_t prev_count = 0;

    if (streak_active) {
        // --- ONGOING STREAK ---
        // Look up how many we already accounted for in this combo
        auto it = active_streaks_.find(streak_key);
        if (it != active_streaks_.end()) {
            prev_count = it->second;
        }
        // Only charge the incremental delta to avoid double-counting
        int32_t delta = repeat_count - prev_count;
        if (delta < 0) delta = 0;   // safety: repeat_count should never decrease

        int64_t diamond_delta = static_cast<int64_t>(delta) * unit_diamonds;

        // Accumulate room total and supporter record
        total_diamonds_ += diamond_delta;
        auto& sup = get_or_create_supporter(user_id, unique_id, nickname, avatar_url);
        sup.total_diamonds += diamond_delta;
        if (delta > 0) ++sup.gift_count;

        txn.total_value = diamond_delta;

        // Update streak tracker to current count
        active_streaks_[streak_key] = repeat_count;

    } else {
        // --- STREAK ENDED (or non-streakable one-shot gift) ---
        auto it = active_streaks_.find(streak_key);
        int32_t already_charged = 0;
        if (it != active_streaks_.end()) {
            already_charged = it->second;
            active_streaks_.erase(it);
        }

        // For the final event, charge the remaining delta
        int32_t final_delta = repeat_count - already_charged;
        if (final_delta < 0) final_delta = 0;

        int64_t diamond_delta = static_cast<int64_t>(final_delta) * unit_diamonds;
        total_diamonds_ += diamond_delta;

        auto& sup = get_or_create_supporter(user_id, unique_id, nickname, avatar_url);
        sup.total_diamonds += diamond_delta;
        if (final_delta > 0) ++sup.gift_count;

        txn.total_value  = diamond_delta;
        txn.repeat_count = repeat_count;
    }

    return txn;
}

// ---------------------------------------------------------------------------
// update_pk_battle
// ---------------------------------------------------------------------------

void LiveRoomEngine::update_pk_battle(
    const std::string& battle_id,
    bool               is_active,
    const std::string& host_name,
    const std::string& opponent_name,
    int64_t            host_score,
    int64_t            opponent_score)
{
    std::lock_guard<std::mutex> lock(mutex_);

    bool was_active = pk_state_.is_active;

    // Detect transition: active → ended → tally wins
    if (was_active && !is_active && pk_state_.battle_id == battle_id) {
        if (pk_state_.host_points >= pk_state_.opponent_points) {
            ++pk_state_.host_wins;
        } else {
            ++pk_state_.opponent_wins;
        }
        ++pk_state_.round_number;
    }

    // New battle
    if (!was_active && is_active) {
        // Reset scores for new round (wins carry over)
        pk_state_.host_points     = 0;
        pk_state_.opponent_points = 0;
    }

    pk_state_.battle_id        = battle_id;
    pk_state_.is_active        = is_active;
    pk_state_.host_username    = host_name;
    pk_state_.opponent_username = opponent_name;

    if (is_active) {
        // Only update scores during active battle
        pk_state_.host_points     = host_score;
        pk_state_.opponent_points = opponent_score;
    }
}

// ---------------------------------------------------------------------------
// update_viewer_count
// ---------------------------------------------------------------------------

void LiveRoomEngine::update_viewer_count(int64_t count) {
    std::lock_guard<std::mutex> lock(mutex_);
    viewer_count_ = count;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

std::vector<Supporter> LiveRoomEngine::get_top_supporters(int limit) const {
    std::lock_guard<std::mutex> lock(mutex_);

    std::vector<Supporter> result;
    result.reserve(supporters_.size());
    for (const auto& [_, s] : supporters_) result.push_back(s);

    int n = std::min(static_cast<int>(result.size()), limit);
    if (n > 0) {
        std::partial_sort(result.begin(), result.begin() + n, result.end(),
                          std::greater<Supporter>());
        result.resize(n);
    }
    return result;
}

std::vector<LikerRecord> LiveRoomEngine::get_top_likers(int limit) const {
    std::lock_guard<std::mutex> lock(mutex_);

    std::vector<LikerRecord> result;
    result.reserve(likers_.size());
    for (const auto& [_, r] : likers_) result.push_back(r);

    int n = std::min(static_cast<int>(result.size()), limit);
    if (n > 0) {
        std::partial_sort(result.begin(), result.begin() + n, result.end(),
                          std::greater<LikerRecord>());
        result.resize(n);
    }
    return result;
}

std::vector<CommentItem> LiveRoomEngine::get_recent_comments(int limit) const {
    std::lock_guard<std::mutex> lock(mutex_);

    int n = std::min(static_cast<int>(comment_buffer_.size()), limit);
    if (n <= 0) return {};

    std::vector<CommentItem> result;
    result.reserve(n);
    auto it = comment_buffer_.rbegin();
    for (int i = 0; i < n; ++i, ++it) result.push_back(*it);
    std::reverse(result.begin(), result.end());  // chronological order
    return result;
}

DashboardSnapshot LiveRoomEngine::get_dashboard_snapshot() const {
    std::lock_guard<std::mutex> lock(mutex_);

    DashboardSnapshot snap;
    snap.total_likes      = total_likes_;
    snap.likes_per_second = like_window_.lps();
    snap.viewer_count     = viewer_count_;
    snap.total_diamonds   = total_diamonds_;
    snap.estimated_usd    = static_cast<double>(total_diamonds_) * 0.005;
    snap.net_payout_usd   = snap.estimated_usd * 0.50;
    snap.total_comments   = total_comments_;
    snap.pk_state         = pk_state_;

    // Top 10 supporters
    {
        std::vector<Supporter> sup_vec;
        sup_vec.reserve(supporters_.size());
        for (const auto& [_, s] : supporters_) sup_vec.push_back(s);
        int n = std::min(static_cast<int>(sup_vec.size()), 10);
        if (n > 0) {
            std::partial_sort(sup_vec.begin(), sup_vec.begin() + n, sup_vec.end(),
                              std::greater<Supporter>());
            sup_vec.resize(n);
        }
        snap.top_supporters = std::move(sup_vec);
    }

    // Top 10 likers
    {
        std::vector<LikerRecord> liker_vec;
        liker_vec.reserve(likers_.size());
        for (const auto& [_, r] : likers_) liker_vec.push_back(r);
        int n = std::min(static_cast<int>(liker_vec.size()), 10);
        if (n > 0) {
            std::partial_sort(liker_vec.begin(), liker_vec.begin() + n, liker_vec.end(),
                              std::greater<LikerRecord>());
            liker_vec.resize(n);
        }
        snap.top_likers = std::move(liker_vec);
    }

    return snap;
}

PKRoundState LiveRoomEngine::get_pk_state() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return pk_state_;
}

double LiveRoomEngine::get_lps() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return like_window_.lps();
}

int64_t LiveRoomEngine::get_total_diamonds() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return total_diamonds_;
}

int64_t LiveRoomEngine::get_total_likes() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return total_likes_;
}

int32_t LiveRoomEngine::get_total_comments() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return total_comments_;
}

void LiveRoomEngine::reset() {
    std::lock_guard<std::mutex> lock(mutex_);
    total_likes_    = 0;
    total_diamonds_ = 0;
    total_comments_ = 0;
    viewer_count_   = 0;
    likers_.clear();
    supporters_.clear();
    active_streaks_.clear();
    comment_buffer_.clear();
    like_window_.entries.clear();
    pk_state_ = PKRoundState{};
}

}  // namespace tiktok
