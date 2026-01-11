import mongoose from "mongoose";

const SongSchema = new mongoose.Schema({
    title : {type : String, required : true},
    artist : {type : String, required : true},
    url : {type : String, required : true},
    coverImage : {type : String},
}, {timestamps : true})

// Export the schema so it can be used with different connections
export { SongSchema };
export default SongSchema;