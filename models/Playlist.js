import mongoose from "mongoose";

const PlaylistSchema = new mongoose.Schema({
    name : {type : String, required : true},
    coverImage : {type : String, required : true, default: "/playlist.png"},
    songs: [{ type: mongoose.Schema.Types.ObjectId, ref: "Song" }],


}, {timestamps : true})

export default mongoose.models.Playlist || mongoose.model("Playlist", PlaylistSchema);