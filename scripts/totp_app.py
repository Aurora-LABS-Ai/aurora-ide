import sys
import time
from urllib.parse import urlparse, parse_qs

import pyotp
from PySide6.QtCore import Qt, QTimer, QRectF
from PySide6.QtGui import QColor, QFont, QPainter, QPen
from PySide6.QtWidgets import (
    QApplication,
    QWidget,
    QVBoxLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QFrame,
)


class CountdownCircle(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.seconds_left = 30
        self.interval = 30
        self.setFixedSize(90, 90)

    def set_time(self, seconds_left: int, interval: int = 30):
        self.seconds_left = max(0, seconds_left)
        self.interval = max(1, interval)
        self.update()

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing)

        rect = QRectF(10, 10, 70, 70)

        background_pen = QPen(QColor("#2f3542"), 8)
        background_pen.setCapStyle(Qt.RoundCap)
        painter.setPen(background_pen)
        painter.drawArc(rect, 0, 360 * 16)

        progress = self.seconds_left / self.interval
        angle = int(360 * progress * 16)

        progress_pen = QPen(QColor("#00d2ff"), 8)
        progress_pen.setCapStyle(Qt.RoundCap)
        painter.setPen(progress_pen)
        painter.drawArc(rect, 90 * 16, angle)

        painter.setPen(QColor("#ffffff"))
        painter.setFont(QFont("Arial", 18, QFont.Bold))
        painter.drawText(self.rect(), Qt.AlignCenter, str(self.seconds_left))


class TotpWindow(QWidget):
    def __init__(self):
        super().__init__()

        self.current_totp = None
        self.interval = 30

        self.setWindowTitle("Live 2FA TOTP Generator")
        self.setMinimumSize(520, 360)

        self.setStyleSheet("""
            QWidget {
                background-color: #111827;
                color: #ffffff;
                font-family: Arial;
            }
            QLineEdit {
                background-color: #1f2937;
                color: #ffffff;
                border: 1px solid #374151;
                border-radius: 10px;
                padding: 12px;
                font-size: 15px;
            }
            QLineEdit:focus {
                border: 1px solid #00d2ff;
            }
            QPushButton {
                background-color: #2563eb;
                color: white;
                border: none;
                border-radius: 10px;
                padding: 10px 14px;
                font-size: 14px;
            }
            QPushButton:hover {
                background-color: #1d4ed8;
            }
            QFrame {
                background-color: #1f2937;
                border-radius: 18px;
            }
        """)

        root = QVBoxLayout(self)
        root.setContentsMargins(28, 28, 28, 28)
        root.setSpacing(18)

        title = QLabel("Live 2FA Code Generator")
        title.setAlignment(Qt.AlignCenter)
        title.setFont(QFont("Arial", 22, QFont.Bold))
        root.addWidget(title)

        subtitle = QLabel("Paste a Google Authenticator compatible Base32 secret or otpauth:// URI.")
        subtitle.setAlignment(Qt.AlignCenter)
        subtitle.setStyleSheet("color: #9ca3af; font-size: 13px;")
        root.addWidget(subtitle)

        self.secret_input = QLineEdit()
        self.secret_input.setPlaceholderText("Example: JBSWY3DPEHPK3PXP")
        self.secret_input.textChanged.connect(self.on_secret_changed)
        root.addWidget(self.secret_input)

        card = QFrame()
        card_layout = QVBoxLayout(card)
        card_layout.setContentsMargins(24, 24, 24, 24)
        card_layout.setSpacing(16)

        self.code_label = QLabel("------")
        self.code_label.setAlignment(Qt.AlignCenter)
        self.code_label.setFont(QFont("Consolas", 44, QFont.Bold))
        self.code_label.setStyleSheet("letter-spacing: 6px;")
        card_layout.addWidget(self.code_label)

        bottom_row = QHBoxLayout()
        bottom_row.setSpacing(18)

        self.countdown = CountdownCircle()
        bottom_row.addWidget(self.countdown, alignment=Qt.AlignCenter)

        info_layout = QVBoxLayout()

        self.status_label = QLabel("Enter a 2FA secret to begin.")
        self.status_label.setStyleSheet("color: #9ca3af; font-size: 14px;")
        self.status_label.setWordWrap(True)
        info_layout.addWidget(self.status_label)

        self.copy_button = QPushButton("Copy Code")
        self.copy_button.clicked.connect(self.copy_code)
        self.copy_button.setEnabled(False)
        info_layout.addWidget(self.copy_button)

        bottom_row.addLayout(info_layout)
        card_layout.addLayout(bottom_row)

        root.addWidget(card)

        self.timer = QTimer(self)
        self.timer.timeout.connect(self.refresh_code)
        self.timer.start(250)

    def normalize_secret(self, value: str) -> str:
        value = value.strip()

        if value.lower().startswith("otpauth://"):
            parsed = urlparse(value)
            query = parse_qs(parsed.query)
            secret = query.get("secret", [""])[0]
            return secret.replace(" ", "").upper()

        return value.replace(" ", "").upper()

    def on_secret_changed(self):
        self.refresh_code()

    def refresh_code(self):
        raw_secret = self.secret_input.text()
        secret = self.normalize_secret(raw_secret)

        if not secret:
            self.current_totp = None
            self.code_label.setText("------")
            self.status_label.setText("Enter a 2FA secret to begin.")
            self.copy_button.setEnabled(False)
            self.countdown.set_time(30, 30)
            return

        try:
            self.current_totp = pyotp.TOTP(secret)
            self.interval = self.current_totp.interval

            now = int(time.time())
            seconds_left = self.interval - (now % self.interval)

            code = self.current_totp.now()

            self.code_label.setText(code)
            self.status_label.setText(f"Code refreshes in {seconds_left} second(s).")
            self.copy_button.setEnabled(True)
            self.countdown.set_time(seconds_left, self.interval)

        except Exception:
            self.current_totp = None
            self.code_label.setText("------")
            self.status_label.setText("Invalid 2FA secret. Paste a valid Base32 secret or otpauth:// URI.")
            self.copy_button.setEnabled(False)
            self.countdown.set_time(30, 30)

    def copy_code(self):
        code = self.code_label.text().strip()
        if code and code != "------":
            QApplication.clipboard().setText(code)
            self.status_label.setText("Code copied to clipboard.")


if __name__ == "__main__":
    app = QApplication(sys.argv)
    window = TotpWindow()
    window.show()
    sys.exit(app.exec())