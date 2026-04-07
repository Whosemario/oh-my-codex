use super::CommandFamily;

pub const FAMILY: CommandFamily = CommandFamily {
    name: "svn",
    pattern: "svn",
    executables: &["svn"],
    description: "Subversion working-copy inspection and source-control commands.",
    what_it_does:
        "Shows working-copy state, diffs, repository info, and history for SVN projects.",
};
