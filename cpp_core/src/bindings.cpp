// =============================================================================
//  bindings.cpp — pybind11 bindings for the TikTok Live Analytics C++ engine.
//  Exposes the `tiktok_cpp_engine` Python extension module.
//
//  FIX: Replaced incorrect py::arg() keyword-syntax inside py::dict() with
//       the correct pybind11 string-literal "_a" operator for dict construction.
//       The old code used py::arg("key") = value inside py::dict(...) which
//       compiles but produces wrong dict key types at runtime.
// =============================================================================

#include <pybind11/pybind11.h>
#include <pybind11/stl.h>     // std::vector / std::string auto-conversion
#include <pybind11/chrono.h>  // chrono type support

#include "live_engine.hpp"

namespace py = pybind11;
using namespace pybind11::literals;  // enables "key"_a syntax for py::dict
using namespace tiktok;

// ---------------------------------------------------------------------------
// Helper: build a py::dict from a Supporter struct
// ---------------------------------------------------------------------------
static py::dict supporter_to_dict(const Supporter& s) {
    return py::dict(
        "user_id"_a        = s.user_id,
        "unique_id"_a      = s.unique_id,
        "nickname"_a       = s.nickname,
        "avatar_url"_a     = s.avatar_url,
        "total_diamonds"_a = s.total_diamonds,
        "gift_count"_a     = s.gift_count
    );
}

static py::dict liker_to_dict(const LikerRecord& r) {
    return py::dict(
        "user_id"_a    = r.user_id,
        "unique_id"_a  = r.unique_id,
        "nickname"_a   = r.nickname,
        "avatar_url"_a = r.avatar_url,
        "like_count"_a = r.like_count
    );
}

static py::dict pk_to_dict(const PKRoundState& pk) {
    return py::dict(
        "is_active"_a         = pk.is_active,
        "battle_id"_a         = pk.battle_id,
        "host_username"_a     = pk.host_username,
        "opponent_username"_a = pk.opponent_username,
        "host_points"_a       = pk.host_points,
        "opponent_points"_a   = pk.opponent_points,
        "host_wins"_a         = pk.host_wins,
        "opponent_wins"_a     = pk.opponent_wins,
        "round_number"_a      = pk.round_number
    );
}

PYBIND11_MODULE(tiktok_cpp_engine, m) {
    m.doc() = "TikTok Live Analytics — high-performance C++17 core engine";

    // -----------------------------------------------------------------------
    // Supporter
    // -----------------------------------------------------------------------
    py::class_<Supporter>(m, "Supporter")
        .def(py::init<>())
        .def_readwrite("user_id",        &Supporter::user_id)
        .def_readwrite("unique_id",      &Supporter::unique_id)
        .def_readwrite("nickname",       &Supporter::nickname)
        .def_readwrite("avatar_url",     &Supporter::avatar_url)
        .def_readwrite("total_diamonds", &Supporter::total_diamonds)
        .def_readwrite("gift_count",     &Supporter::gift_count)
        .def("to_dict", [](const Supporter& s) { return supporter_to_dict(s); })
        .def("__repr__", [](const Supporter& s) {
            return "<Supporter @" + s.unique_id + " diamonds=" +
                   std::to_string(s.total_diamonds) + ">";
        });

    // -----------------------------------------------------------------------
    // CommentItem
    // -----------------------------------------------------------------------
    py::class_<CommentItem>(m, "CommentItem")
        .def(py::init<>())
        .def_readwrite("user_id",      &CommentItem::user_id)
        .def_readwrite("unique_id",    &CommentItem::unique_id)
        .def_readwrite("nickname",     &CommentItem::nickname)
        .def_readwrite("avatar_url",   &CommentItem::avatar_url)
        .def_readwrite("comment_text", &CommentItem::comment_text)
        .def_readwrite("timestamp_ms", &CommentItem::timestamp_ms)
        .def_readwrite("user_level",   &CommentItem::user_level)
        .def("to_dict", [](const CommentItem& c) {
            return py::dict(
                "user_id"_a      = c.user_id,
                "unique_id"_a    = c.unique_id,
                "nickname"_a     = c.nickname,
                "avatar_url"_a   = c.avatar_url,
                "comment_text"_a = c.comment_text,
                "timestamp_ms"_a = c.timestamp_ms,
                "user_level"_a   = c.user_level
            );
        })
        .def("__repr__", [](const CommentItem& c) {
            return "<Comment @" + c.unique_id + ": " + c.comment_text + ">";
        });

    // -----------------------------------------------------------------------
    // GiftTransaction
    // -----------------------------------------------------------------------
    py::class_<GiftTransaction>(m, "GiftTransaction")
        .def(py::init<>())
        .def_readwrite("gift_id",           &GiftTransaction::gift_id)
        .def_readwrite("gift_name",         &GiftTransaction::gift_name)
        .def_readwrite("gift_icon_url",     &GiftTransaction::gift_icon_url)
        .def_readwrite("diamond_unit_cost", &GiftTransaction::diamond_unit_cost)
        .def_readwrite("repeat_count",      &GiftTransaction::repeat_count)
        .def_readwrite("is_streak_ending",  &GiftTransaction::is_streak_ending)
        .def_readwrite("total_value",       &GiftTransaction::total_value)
        .def("to_dict", [](const GiftTransaction& g) {
            return py::dict(
                "gift_id"_a           = g.gift_id,
                "gift_name"_a         = g.gift_name,
                "gift_icon_url"_a     = g.gift_icon_url,
                "diamond_unit_cost"_a = g.diamond_unit_cost,
                "repeat_count"_a      = g.repeat_count,
                "is_streak_ending"_a  = g.is_streak_ending,
                "total_value"_a       = g.total_value
            );
        });

    // -----------------------------------------------------------------------
    // LikerRecord
    // -----------------------------------------------------------------------
    py::class_<LikerRecord>(m, "LikerRecord")
        .def(py::init<>())
        .def_readwrite("user_id",    &LikerRecord::user_id)
        .def_readwrite("unique_id",  &LikerRecord::unique_id)
        .def_readwrite("nickname",   &LikerRecord::nickname)
        .def_readwrite("avatar_url", &LikerRecord::avatar_url)
        .def_readwrite("like_count", &LikerRecord::like_count)
        .def("to_dict", [](const LikerRecord& r) { return liker_to_dict(r); });

    // -----------------------------------------------------------------------
    // PKRoundState
    // -----------------------------------------------------------------------
    py::class_<PKRoundState>(m, "PKRoundState")
        .def(py::init<>())
        .def_readwrite("is_active",         &PKRoundState::is_active)
        .def_readwrite("battle_id",         &PKRoundState::battle_id)
        .def_readwrite("host_username",     &PKRoundState::host_username)
        .def_readwrite("opponent_username", &PKRoundState::opponent_username)
        .def_readwrite("host_points",       &PKRoundState::host_points)
        .def_readwrite("opponent_points",   &PKRoundState::opponent_points)
        .def_readwrite("host_wins",         &PKRoundState::host_wins)
        .def_readwrite("opponent_wins",     &PKRoundState::opponent_wins)
        .def_readwrite("round_number",      &PKRoundState::round_number)
        .def("to_dict", [](const PKRoundState& pk) { return pk_to_dict(pk); });

    // -----------------------------------------------------------------------
    // DashboardSnapshot
    // -----------------------------------------------------------------------
    py::class_<DashboardSnapshot>(m, "DashboardSnapshot")
        .def(py::init<>())
        .def_readwrite("total_likes",      &DashboardSnapshot::total_likes)
        .def_readwrite("likes_per_second", &DashboardSnapshot::likes_per_second)
        .def_readwrite("viewer_count",     &DashboardSnapshot::viewer_count)
        .def_readwrite("total_diamonds",   &DashboardSnapshot::total_diamonds)
        .def_readwrite("estimated_usd",    &DashboardSnapshot::estimated_usd)
        .def_readwrite("net_payout_usd",   &DashboardSnapshot::net_payout_usd)
        .def_readwrite("total_comments",   &DashboardSnapshot::total_comments)
        .def_readwrite("pk_state",         &DashboardSnapshot::pk_state)
        .def_readwrite("top_supporters",   &DashboardSnapshot::top_supporters)
        .def_readwrite("top_likers",       &DashboardSnapshot::top_likers)
        .def("to_dict", [](const DashboardSnapshot& snap) {
            py::list supporters_list;
            for (const auto& s : snap.top_supporters)
                supporters_list.append(supporter_to_dict(s));

            py::list likers_list;
            for (const auto& r : snap.top_likers)
                likers_list.append(liker_to_dict(r));

            return py::dict(
                "total_likes"_a      = snap.total_likes,
                "likes_per_second"_a = snap.likes_per_second,
                "viewer_count"_a     = snap.viewer_count,
                "total_diamonds"_a   = snap.total_diamonds,
                "estimated_usd"_a    = snap.estimated_usd,
                "net_payout_usd"_a   = snap.net_payout_usd,
                "total_comments"_a   = snap.total_comments,
                "pk_state"_a         = pk_to_dict(snap.pk_state),
                "top_supporters"_a   = supporters_list,
                "top_likers"_a       = likers_list
            );
        });

    // -----------------------------------------------------------------------
    // LiveRoomEngine — main class
    // -----------------------------------------------------------------------
    py::class_<LiveRoomEngine>(m, "LiveRoomEngine",
            "Thread-safe analytics engine for one TikTok Live room session.")
        .def(py::init<std::string>(),
             py::arg("host_username") = "",
             "Create a new engine instance for host_username.")

        // --- Event processors ---
        .def("process_like",
             &LiveRoomEngine::process_like,
             py::arg("user_id"), py::arg("unique_id"), py::arg("nickname"),
             py::arg("avatar_url"), py::arg("like_count"), py::arg("total_room_likes"),
             py::call_guard<py::gil_scoped_release>(),
             "Process a LikeEvent. Returns updated total_likes.")

        .def("process_comment",
             &LiveRoomEngine::process_comment,
             py::arg("user_id"), py::arg("unique_id"), py::arg("nickname"),
             py::arg("avatar_url"), py::arg("text"), py::arg("timestamp_ms"),
             py::arg("user_level") = 0,
             py::call_guard<py::gil_scoped_release>(),
             "Process a CommentEvent. Returns the stored CommentItem.")

        .def("process_gift",
             &LiveRoomEngine::process_gift,
             py::arg("user_id"), py::arg("unique_id"), py::arg("nickname"),
             py::arg("avatar_url"), py::arg("gift_id"), py::arg("gift_name"),
             py::arg("gift_icon"), py::arg("unit_diamonds"),
             py::arg("repeat_count"), py::arg("streak_active"),
             py::call_guard<py::gil_scoped_release>(),
             "Process a GiftEvent with full streak deduplication. Returns GiftTransaction.")

        .def("update_pk_battle",
             &LiveRoomEngine::update_pk_battle,
             py::arg("battle_id"), py::arg("is_active"),
             py::arg("host_name"), py::arg("opponent_name"),
             py::arg("host_score"), py::arg("opponent_score"),
             py::call_guard<py::gil_scoped_release>(),
             "Update PK battle state and auto-tally wins on round end.")

        .def("update_viewer_count",
             &LiveRoomEngine::update_viewer_count,
             py::arg("count"),
             py::call_guard<py::gil_scoped_release>(),
             "Update the live viewer count.")

        // --- Queries ---
        .def("get_top_supporters",
             &LiveRoomEngine::get_top_supporters,
             py::arg("limit") = 10,
             py::call_guard<py::gil_scoped_release>(),
             "Return top N gifters sorted by total_diamonds descending.")

        .def("get_top_likers",
             &LiveRoomEngine::get_top_likers,
             py::arg("limit") = 10,
             py::call_guard<py::gil_scoped_release>(),
             "Return top N likers sorted by like_count descending.")

        .def("get_recent_comments",
             &LiveRoomEngine::get_recent_comments,
             py::arg("limit") = 50,
             py::call_guard<py::gil_scoped_release>(),
             "Return last N comments in chronological order.")

        .def("get_dashboard_snapshot",
             &LiveRoomEngine::get_dashboard_snapshot,
             py::call_guard<py::gil_scoped_release>(),
             "Return a complete DashboardSnapshot for JSON serialisation.")

        .def("get_pk_state",
             &LiveRoomEngine::get_pk_state,
             py::call_guard<py::gil_scoped_release>(),
             "Return the current PKRoundState.")

        .def("get_lps",
             &LiveRoomEngine::get_lps,
             py::call_guard<py::gil_scoped_release>(),
             "Return rolling 5-second Likes Per Second.")

        .def("get_total_diamonds",
             &LiveRoomEngine::get_total_diamonds,
             py::call_guard<py::gil_scoped_release>(),
             "Return total diamonds accumulated this session.")

        .def("get_total_likes",
             &LiveRoomEngine::get_total_likes,
             py::call_guard<py::gil_scoped_release>(),
             "Return total likes accumulated this session.")

        .def("get_total_comments",
             &LiveRoomEngine::get_total_comments,
             py::call_guard<py::gil_scoped_release>(),
             "Return total comment count this session.")

        .def("reset",
             &LiveRoomEngine::reset,
             "Reset all session state (call before starting a new tracking session).");

    // Module-level constants
    m.attr("DIAMOND_TO_USD_RATE") = py::float_(0.005);
    m.attr("NET_PAYOUT_RATIO")    = py::float_(0.50);
    m.attr("COMMENT_BUFFER_SIZE") = py::int_(200);
    m.attr("LPS_WINDOW_SECS")     = py::float_(5.0);
    m.attr("__version__")         = "1.0.0";
}
