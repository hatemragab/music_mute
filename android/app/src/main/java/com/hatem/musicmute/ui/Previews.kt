package com.hatem.musicmute.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview
import com.hatem.musicmute.data.AudioSource
import com.hatem.musicmute.data.WorkflowStage
import com.hatem.musicmute.state.DemoSession
import com.hatem.musicmute.state.VocalUiState
import com.hatem.musicmute.state.WorkflowState

@Preview(name = "Home • English • light", widthDp = 390, heightDp = 1000, showBackground = true)
@Preview(
    name = "Home • Arabic RTL",
    locale = "ar",
    widthDp = 390,
    heightDp = 1000,
    showBackground = true,
)
@Preview(
    name = "Home • narrow • large text",
    widthDp = 320,
    heightDp = 1200,
    fontScale = 1.6f,
    showBackground = true,
)
@Composable
private fun HomePreview() = VocalTheme(dark = false) { Surface { HomeScreen(VocalUiState()) } }

@Preview(name = "Home • dark", widthDp = 390, heightDp = 1000)
@Composable
private fun DarkPreview() =
    VocalTheme(dark = true) { Surface { HomeScreen(VocalUiState(source = AudioSource.SAMPLE)) } }

@Preview(name = "Home • invalid URL", widthDp = 390, heightDp = 1000)
@Composable
private fun InvalidPreview() = VocalTheme {
    Surface { HomeScreen(VocalUiState(url = "https://example.com", invalidUrl = true)) }
}

@Preview(name = "Processing", widthDp = 390, heightDp = 900)
@Composable
private fun ProcessingPreview() = VocalTheme {
    Surface {
        WorkflowScreen(
            VocalUiState(workflow = WorkflowState.Running(WorkflowStage.PREPARING, .45f))
        )
    }
}

@Preview(name = "Cancelled", widthDp = 390, heightDp = 800)
@Composable
private fun CancelledPreview() = VocalTheme {
    Surface { WorkflowScreen(VocalUiState(workflow = WorkflowState.Cancelled)) }
}

@Preview(name = "Failure and retry", widthDp = 390, heightDp = 800)
@Composable
private fun FailurePreview() = VocalTheme {
    Surface { WorkflowScreen(VocalUiState(workflow = WorkflowState.Failed)) }
}

@Preview(name = "Result • Arabic • dark", locale = "ar", widthDp = 390, heightDp = 1200)
@Composable
private fun ResultPreview() = VocalTheme(dark = true) { Surface { ResultScreen() } }

@Preview(name = "Library • empty", widthDp = 390, heightDp = 850)
@Composable
private fun EmptyLibraryPreview() = VocalTheme { Surface { LibraryScreen(emptyList()) } }

@Preview(name = "Library • examples", widthDp = 390, heightDp = 850)
@Composable
private fun LibraryPreview() = VocalTheme {
    Surface { LibraryScreen(listOf(DemoSession("preview", AudioSource.SAMPLE))) }
}

@Preview(name = "Settings • loading", widthDp = 390, heightDp = 1100)
@Composable
private fun LoadingPreview() = VocalTheme { Surface { SettingsScreen(VocalUiState()) } }

@Preview(name = "Settings • Arabic RTL", locale = "ar", widthDp = 390, heightDp = 1100)
@Composable
private fun SettingsPreview() = VocalTheme {
    Surface { SettingsScreen(VocalUiState(preferencesLoading = false)) }
}
