package com.hatem.musicmute.ui.auth

import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview
import com.hatem.musicmute.auth.AuthUiState
import com.hatem.musicmute.ui.VocalTheme

@Preview(name = "Deletion sections · English", showBackground = true)
@Preview(name = "Deletion sections · Arabic", locale = "ar", fontScale = 1.3f, showBackground = true)
@Composable
private fun DeletionReviewPreview() {
    VocalTheme {
        AccountDeletionReviewScreen(AuthUiState(), "", {}, {}, {}, {})
    }
}

@Preview(name = "Verification sheet", showBackground = true)
@Composable
private fun VerificationPreview() {
    VocalTheme { EmailVerificationSheet(AuthUiState(), "voice@example.com", 0, {}, {}, {}, {}) }
}
