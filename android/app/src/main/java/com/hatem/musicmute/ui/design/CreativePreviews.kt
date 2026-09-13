package com.hatem.musicmute.ui.design

import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.ui.tooling.preview.Preview
import com.hatem.musicmute.ui.VocalTheme

@Preview(name = "Creative components", widthDp = 390, heightDp = 800)
@Preview(name = "Creative large Arabic", widthDp = 390, heightDp = 900, locale = "ar", fontScale = 1.6f)
@Composable
private fun CreativeComponentsPreview() {
    VocalTheme {
        Surface {
            CreativePage {
                CreativeHeader("MusicMute", "Your voice, ready to listen")
                CreativeCard {
                    CreativeTextField("", {}, "Email")
                    CreativePrimaryButton({}, Modifier.fillMaxWidth()) { Text("Continue") }
                    CreativeFeedback("Available offline")
                }
                CreativeCard {
                    CreativeFeedback("A saved result stays available while offline.", actionLabel = "Retry", onAction = {})
                    CreativeStarButton(true, {}, "Starred")
                }
            }
        }
    }
}
